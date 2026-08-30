#!/usr/bin/env python3
"""Claude <-> Gemini automated dialogue runner.

Keeps a single neutral transcript and converts it to each API's
perspective immediately before that API is called. Uses only the
Python standard library (urllib.request) -- no third-party SDKs.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Callable, Optional

END_MARKER = "[END]"
MAX_TURNS_ALLOWED = 40

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
GEMINI_API_URL_TMPL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
)

DEFAULT_CLAUDE_MODEL = "claude-sonnet-5"
DEFAULT_GEMINI_MODEL = "gemini-3.7-flash"

OTHER = {"claude": "gemini", "gemini": "claude"}


class DialogueError(Exception):
    """Raised for unrecoverable configuration/response errors (no retry)."""


# ---------------------------------------------------------------------------
# Transcript <-> per-API perspective conversion
# ---------------------------------------------------------------------------


def _apply_window(transcript: list[dict], window: Optional[int]) -> list[dict]:
    if window is None or window <= 0:
        return list(transcript)
    return list(transcript[-window:])


def _trim_leading_self(entries: list[dict], me: str) -> list[dict]:
    """Drop leading turns spoken by `me` so the sequence starts with the
    opponent's turn, as required by both chat APIs."""
    i = 0
    while i < len(entries) and entries[i]["speaker"] == me:
        i += 1
    return entries[i:]


def _windowed_entries(transcript: list[dict], me: str, window: Optional[int]) -> list[dict]:
    return _trim_leading_self(_apply_window(transcript, window), me)


def to_anthropic_messages(
    transcript: list[dict], me: str, window: Optional[int] = None
) -> list[dict]:
    """Convert the neutral transcript into Anthropic `messages` format from
    `me`'s point of view: `me`'s turns become `assistant`, the other
    speaker's turns become `user`."""
    entries = _windowed_entries(transcript, me, window)
    return [
        {"role": "assistant" if e["speaker"] == me else "user", "content": e["text"]}
        for e in entries
    ]


def to_gemini_contents(
    transcript: list[dict], me: str, window: Optional[int] = None
) -> list[dict]:
    """Convert the neutral transcript into Gemini `contents` format from
    `me`'s point of view: `me`'s turns become `model`, the other speaker's
    turns become `user`."""
    entries = _windowed_entries(transcript, me, window)
    return [
        {
            "role": "model" if e["speaker"] == me else "user",
            "parts": [{"text": e["text"]}],
        }
        for e in entries
    ]


def build_system_prompt(topic: str, speaker: str, persona: Optional[str]) -> str:
    lines = [
        f"あなたは「{speaker}」として、もう一方のAIと対話しています。",
        f"お題: {topic}",
    ]
    if persona:
        lines.append(f"あなたのペルソナ: {persona}")
    lines.append(
        "議論が尽きた、あるいはこれ以上続ける必要がないと判断したら、"
        f"発言の末尾に必ず {END_MARKER} と書いてください。"
    )
    return "\n".join(lines)


def _kickoff_message(topic: str) -> str:
    return f"これから次のお題について対話してください: {topic}"


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def _http_post_json(url: str, headers: dict, payload: dict, timeout: float = 60.0) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        err = DialogueError(f"HTTP {e.code} from {url}: {body}")
        err.status_code = e.code  # type: ignore[attr-defined]
        raise err


def _with_retry(fn: Callable[[], dict], max_attempts: int = 4) -> dict:
    """Retry on 429/5xx with exponential backoff (1s, 2s, 4s, 8s). Any other
    error (raised as DialogueError without a retryable status, or any other
    exception) is propagated immediately."""
    delay = 1.0
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except DialogueError as e:
            status = getattr(e, "status_code", None)
            retryable = status == 429 or (status is not None and 500 <= status < 600)
            if not retryable or attempt == max_attempts:
                raise
            time.sleep(delay)
            delay *= 2
    raise DialogueError("unreachable")  # pragma: no cover


# ---------------------------------------------------------------------------
# API calls
# ---------------------------------------------------------------------------


def call_claude(
    system_prompt: str,
    messages: list[dict],
    api_key: str,
    model: str,
    max_tokens: int,
) -> str:
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system_prompt,
        "messages": messages,
    }
    headers = {
        "content-type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }

    def do_call() -> dict:
        return _http_post_json(ANTHROPIC_API_URL, headers, payload)

    data = _with_retry(do_call)
    content = data.get("content")
    if not content:
        raise DialogueError(f"Anthropic response has no content: {data}")
    parts = [
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    text = "".join(parts).strip()
    if not text:
        raise DialogueError(f"Anthropic response had no text blocks: {data}")
    return text


def call_gemini(
    system_prompt: str,
    contents: list[dict],
    api_key: str,
    model: str,
    max_tokens: int,
) -> str:
    payload = {
        "contents": contents,
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "generationConfig": {"maxOutputTokens": max_tokens},
    }
    headers = {
        "content-type": "application/json",
        "x-goog-api-key": api_key,
    }
    url = GEMINI_API_URL_TMPL.format(model=model)

    def do_call() -> dict:
        return _http_post_json(url, headers, payload)

    data = _with_retry(do_call)
    candidates = data.get("candidates") or []
    if not candidates:
        raise DialogueError(f"Gemini response had no candidates: {data}")
    candidate = candidates[0]
    parts = candidate.get("content", {}).get("parts") or []
    if not parts:
        finish_reason = candidate.get("finishReason", "UNKNOWN")
        raise DialogueError(
            f"Gemini response had no parts (finishReason={finish_reason}): {data}"
        )
    text = "".join(
        part.get("text", "") for part in parts if not part.get("thought")
    ).strip()
    if not text:
        finish_reason = candidate.get("finishReason", "UNKNOWN")
        raise DialogueError(
            f"Gemini response had only thought parts (finishReason={finish_reason}): {data}"
        )
    return text


# ---------------------------------------------------------------------------
# Dialogue loop
# ---------------------------------------------------------------------------


def run_dialogue(
    topic: str,
    turns: int,
    first: str,
    claude_persona: Optional[str],
    gemini_persona: Optional[str],
    max_tokens: int,
    window: int,
    delay: float,
    claude_caller: Callable[[str, list[dict], int], str],
    gemini_caller: Callable[[str, list[dict], int], str],
    sleep_fn: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = lambda s: print(s, flush=True),
) -> list[dict]:
    """Run the dialogue loop. `claude_caller(system_prompt, messages,
    max_tokens) -> text` and `gemini_caller(system_prompt, contents,
    max_tokens) -> text` are injected so this loop is unit-testable without
    network access."""
    if turns > MAX_TURNS_ALLOWED:
        raise DialogueError(
            f"--turns {turns} exceeds the safety limit of {MAX_TURNS_ALLOWED}"
        )

    personas = {"claude": claude_persona, "gemini": gemini_persona}
    transcript: list[dict] = []
    speaker = first

    for turn_index in range(turns):
        system_prompt = build_system_prompt(topic, speaker, personas[speaker])

        if speaker == "claude":
            messages = to_anthropic_messages(transcript, "claude", window)
            if not messages:
                messages = [{"role": "user", "content": _kickoff_message(topic)}]
            text = claude_caller(system_prompt, messages, max_tokens)
        else:
            contents = to_gemini_contents(transcript, "gemini", window)
            if not contents:
                contents = [
                    {"role": "user", "parts": [{"text": _kickoff_message(topic)}]}
                ]
            text = gemini_caller(system_prompt, contents, max_tokens)

        transcript.append({"speaker": speaker, "text": text})
        log(f"--- turn {turn_index + 1} ({speaker}) ---\n{text}\n")

        if END_MARKER in text:
            break

        speaker = OTHER[speaker]
        if delay:
            sleep_fn(delay)

    return transcript


# ---------------------------------------------------------------------------
# Transcript persistence
# ---------------------------------------------------------------------------


def save_transcript_markdown(
    transcript: list[dict],
    topic: str,
    args: argparse.Namespace,
    out_dir: str = "transcripts",
) -> str:
    os.makedirs(out_dir, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    path = os.path.join(out_dir, f"{timestamp}.md")

    lines = [f"# {topic}", ""]
    lines.append("## 設定")
    lines.append(f"- turns: {args.turns}")
    lines.append(f"- first: {args.first}")
    lines.append(f"- claude_persona: {args.claude_persona or '(none)'}")
    lines.append(f"- gemini_persona: {args.gemini_persona or '(none)'}")
    lines.append(f"- max_tokens: {args.max_tokens}")
    lines.append(f"- window: {args.window}")
    lines.append("")
    lines.append("## 対話")
    for entry in transcript:
        lines.append(f"### {entry['speaker']}")
        lines.append("")
        lines.append(entry["text"])
        lines.append("")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Claude <-> Gemini dialogue runner")
    parser.add_argument("--topic", required=True)
    parser.add_argument("--turns", type=int, default=6)
    parser.add_argument("--first", choices=["claude", "gemini"], default="claude")
    parser.add_argument("--claude-persona", default=None)
    parser.add_argument("--gemini-persona", default=None)
    parser.add_argument("--max-tokens", type=int, default=1000)
    parser.add_argument("--window", type=int, default=12)
    parser.add_argument("--delay", type=float, default=1.0)
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)

    if args.turns > MAX_TURNS_ALLOWED:
        print(
            f"error: --turns {args.turns} exceeds the safety limit of "
            f"{MAX_TURNS_ALLOWED}",
            file=sys.stderr,
        )
        return 1

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    gemini_key = os.environ.get("GEMINI_API_KEY")
    if not anthropic_key or not gemini_key:
        print(
            "error: ANTHROPIC_API_KEY and GEMINI_API_KEY must be set in the "
            "environment",
            file=sys.stderr,
        )
        return 1

    claude_model = os.environ.get("CLAUDE_MODEL", DEFAULT_CLAUDE_MODEL)
    gemini_model = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL)

    def claude_caller(system_prompt: str, messages: list[dict], max_tokens: int) -> str:
        return call_claude(system_prompt, messages, anthropic_key, claude_model, max_tokens)

    def gemini_caller(system_prompt: str, contents: list[dict], max_tokens: int) -> str:
        return call_gemini(system_prompt, contents, gemini_key, gemini_model, max_tokens)

    transcript = run_dialogue(
        topic=args.topic,
        turns=args.turns,
        first=args.first,
        claude_persona=args.claude_persona,
        gemini_persona=args.gemini_persona,
        max_tokens=args.max_tokens,
        window=args.window,
        delay=args.delay,
        claude_caller=claude_caller,
        gemini_caller=gemini_caller,
    )

    path = save_transcript_markdown(transcript, args.topic, args)
    print(f"\nSaved transcript to {path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
