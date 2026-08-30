import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dialogue  # noqa: E402


SAMPLE_TRANSCRIPT = [
    {"speaker": "claude", "text": "claude turn 1"},
    {"speaker": "gemini", "text": "gemini turn 1"},
    {"speaker": "claude", "text": "claude turn 2"},
]


class ToAnthropicMessagesTest(unittest.TestCase):
    def test_perspective_from_claude(self):
        # SAMPLE_TRANSCRIPT starts with claude's own turn; since the first
        # entry passed to an API must always be the opponent's turn, that
        # leading self-turn is trimmed.
        result = dialogue.to_anthropic_messages(SAMPLE_TRANSCRIPT, "claude")
        self.assertEqual(
            result,
            [
                {"role": "user", "content": "gemini turn 1"},
                {"role": "assistant", "content": "claude turn 2"},
            ],
        )

    def test_roles_mapped_correctly_with_opponent_leading(self):
        transcript = [
            {"speaker": "gemini", "text": "gemini turn 1"},
            {"speaker": "claude", "text": "claude turn 1"},
            {"speaker": "gemini", "text": "gemini turn 2"},
        ]
        result = dialogue.to_anthropic_messages(transcript, "claude")
        self.assertEqual(
            result,
            [
                {"role": "user", "content": "gemini turn 1"},
                {"role": "assistant", "content": "claude turn 1"},
                {"role": "user", "content": "gemini turn 2"},
            ],
        )

    def test_perspective_from_gemini(self):
        result = dialogue.to_anthropic_messages(SAMPLE_TRANSCRIPT, "gemini")
        self.assertEqual(
            result,
            [
                {"role": "user", "content": "claude turn 1"},
                {"role": "assistant", "content": "gemini turn 1"},
                {"role": "user", "content": "claude turn 2"},
            ],
        )


class ToGeminiContentsTest(unittest.TestCase):
    def test_perspective_from_gemini(self):
        result = dialogue.to_gemini_contents(SAMPLE_TRANSCRIPT, "gemini")
        self.assertEqual(
            result,
            [
                {"role": "user", "parts": [{"text": "claude turn 1"}]},
                {"role": "model", "parts": [{"text": "gemini turn 1"}]},
                {"role": "user", "parts": [{"text": "claude turn 2"}]},
            ],
        )

    def test_perspective_from_claude_trims_leading_self_turn(self):
        # SAMPLE_TRANSCRIPT starts with claude's own turn, which must be
        # trimmed so the sequence starts with the opponent (gemini).
        result = dialogue.to_gemini_contents(SAMPLE_TRANSCRIPT, "claude")
        self.assertEqual(result[0]["role"], "user")
        self.assertEqual(result[-1]["role"], "model")


class WindowTrimTest(unittest.TestCase):
    def test_window_drops_leading_self_turn(self):
        # window=2 would naively keep the last two entries: [gemini1, claude2]
        # which, from claude's perspective, starts with the opponent (gemini) -
        # fine. But from gemini's perspective it would start with claude2
        # (gemini's own... no wait claude2 is the opponent for gemini). Use a
        # case where the leading entry after windowing is the caller's own turn.
        transcript = [
            {"speaker": "gemini", "text": "g1"},
            {"speaker": "claude", "text": "c1"},
            {"speaker": "gemini", "text": "g2"},
            {"speaker": "claude", "text": "c2"},
        ]
        # window=1 keeps only the last entry (claude: c2), which is the
        # caller's own turn when calling as claude -> must be trimmed to empty.
        result = dialogue.to_anthropic_messages(transcript, "claude", window=1)
        self.assertEqual(result, [])

    def test_window_keeps_opponent_leading(self):
        transcript = [
            {"speaker": "claude", "text": "c1"},
            {"speaker": "gemini", "text": "g1"},
            {"speaker": "claude", "text": "c2"},
            {"speaker": "gemini", "text": "g2"},
        ]
        result = dialogue.to_gemini_contents(transcript, "gemini", window=3)
        # last 3: [g1, c2, g2] -> from gemini's perspective, leading g1 is
        # gemini's own turn, must be trimmed -> [c2(user), g2(model)]
        self.assertEqual(result[0]["role"], "user")
        self.assertEqual(result[-1]["role"], "model")


class DialogueLoopTest(unittest.TestCase):
    def _run(self, topic="test topic", turns=4, first="claude", **kwargs):
        calls = []

        def claude_caller(system_prompt, messages, max_tokens):
            calls.append(("claude", system_prompt, messages))
            return kwargs.get("claude_texts", ["claude reply"] * turns).pop(0) \
                if "claude_texts" in kwargs else "claude reply"

        def gemini_caller(system_prompt, contents, max_tokens):
            calls.append(("gemini", system_prompt, contents))
            return "gemini reply"

        transcript = dialogue.run_dialogue(
            topic=topic,
            turns=turns,
            first=first,
            claude_persona=None,
            gemini_persona=None,
            max_tokens=100,
            window=12,
            delay=0,
            claude_caller=claude_caller,
            gemini_caller=gemini_caller,
            sleep_fn=lambda s: None,
            log=lambda s: None,
        )
        return transcript, calls

    def test_strict_alternation(self):
        transcript, calls = self._run(turns=5, first="claude")
        speakers = [c[0] for c in calls]
        self.assertEqual(speakers, ["claude", "gemini", "claude", "gemini", "claude"])

    def test_first_entry_always_opponent(self):
        transcript, calls = self._run(turns=6, first="claude")
        for speaker, system_prompt, msgs_or_contents in calls:
            if not msgs_or_contents:
                continue
            first_entry = msgs_or_contents[0]
            if speaker == "claude":
                self.assertEqual(first_entry["role"], "user")
            else:
                self.assertEqual(first_entry["role"], "user")

    def test_system_prompt_contains_topic(self):
        topic = "unique-topic-marker-xyz"
        transcript, calls = self._run(topic=topic, turns=4)
        for _, system_prompt, _ in calls:
            self.assertIn(topic, system_prompt)

    def test_end_marker_stops_loop_immediately(self):
        texts = iter(["first reply", "second reply [END]", "should not happen"])

        def claude_caller(system_prompt, messages, max_tokens):
            return next(texts)

        def gemini_caller(system_prompt, contents, max_tokens):
            return next(texts)

        transcript = dialogue.run_dialogue(
            topic="t",
            turns=10,
            first="claude",
            claude_persona=None,
            gemini_persona=None,
            max_tokens=100,
            window=12,
            delay=0,
            claude_caller=claude_caller,
            gemini_caller=gemini_caller,
            sleep_fn=lambda s: None,
            log=lambda s: None,
        )
        self.assertEqual(len(transcript), 2)
        self.assertIn(dialogue.END_MARKER, transcript[-1]["text"])

    def test_turns_over_limit_rejected(self):
        with self.assertRaises(dialogue.DialogueError):
            dialogue.run_dialogue(
                topic="t",
                turns=41,
                first="claude",
                claude_persona=None,
                gemini_persona=None,
                max_tokens=100,
                window=12,
                delay=0,
                claude_caller=lambda *a: "x",
                gemini_caller=lambda *a: "x",
                sleep_fn=lambda s: None,
                log=lambda s: None,
            )


class ExtractTextTest(unittest.TestCase):
    @patch("dialogue._with_retry")
    def test_claude_excludes_thinking_blocks(self, mock_retry):
        mock_retry.return_value = {
            "content": [
                {"type": "thinking", "text": "internal reasoning, ignore me"},
                {"type": "text", "text": "visible answer"},
            ]
        }
        text = dialogue.call_claude("sys", [], "key", "model", 100)
        self.assertEqual(text, "visible answer")
        self.assertNotIn("internal reasoning", text)

    @patch("dialogue._with_retry")
    def test_gemini_excludes_thought_parts(self, mock_retry):
        mock_retry.return_value = {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {"text": "secret thought", "thought": True},
                            {"text": "visible answer"},
                        ]
                    },
                    "finishReason": "STOP",
                }
            ]
        }
        text = dialogue.call_gemini("sys", [], "key", "model", 100)
        self.assertEqual(text, "visible answer")
        self.assertNotIn("secret thought", text)

    @patch("dialogue._with_retry")
    def test_gemini_no_candidates_raises_explicit_error(self, mock_retry):
        mock_retry.return_value = {"candidates": []}
        with self.assertRaises(dialogue.DialogueError):
            dialogue.call_gemini("sys", [], "key", "model", 100)

    @patch("dialogue._with_retry")
    def test_gemini_max_tokens_no_parts_raises_explicit_error(self, mock_retry):
        mock_retry.return_value = {
            "candidates": [{"content": {}, "finishReason": "MAX_TOKENS"}]
        }
        with self.assertRaises(dialogue.DialogueError):
            dialogue.call_gemini("sys", [], "key", "model", 100)


class RetryTest(unittest.TestCase):
    def test_retries_on_429_then_succeeds(self):
        attempts = {"n": 0}

        def flaky():
            attempts["n"] += 1
            if attempts["n"] < 3:
                err = dialogue.DialogueError("rate limited")
                err.status_code = 429
                raise err
            return {"ok": True}

        with patch("dialogue.time.sleep", return_value=None):
            result = dialogue._with_retry(flaky)
        self.assertEqual(result, {"ok": True})
        self.assertEqual(attempts["n"], 3)

    def test_no_retry_on_400(self):
        attempts = {"n": 0}

        def bad_request():
            attempts["n"] += 1
            err = dialogue.DialogueError("bad request")
            err.status_code = 400
            raise err

        with self.assertRaises(dialogue.DialogueError):
            dialogue._with_retry(bad_request)
        self.assertEqual(attempts["n"], 1)


class CLITest(unittest.TestCase):
    def test_turns_41_exits_before_running(self):
        argv = ["--topic", "t", "--turns", "41"]
        with patch.dict(
            os.environ, {"ANTHROPIC_API_KEY": "x", "GEMINI_API_KEY": "y"}
        ):
            with patch("dialogue.run_dialogue") as mock_run:
                rc = dialogue.main(argv)
        self.assertNotEqual(rc, 0)
        mock_run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
