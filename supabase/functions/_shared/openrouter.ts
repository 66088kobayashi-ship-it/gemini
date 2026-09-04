// OpenRouter (OpenAI互換) アダプタ。engine.ts の CallModelFn を満たす。
// キーはここでヘッダに載せるだけで、ログ・エラーメッセージ・戻り値には
// 一切含めない。

import type { AdapterMessage, CallModelArgs, CallModelFn } from "./engine.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export class InsufficientBalanceError extends Error {
  constructor(message = "OpenRouterの残高が不足しています") {
    super(message);
    this.name = "InsufficientBalanceError";
  }
}

export interface OpenRouterOptions {
  apiKey: string;
  maxTokens?: number;
  maxAttempts?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

function toOpenAiMessages(
  systemPrompt: string,
  messages: AdapterMessage[],
): Array<{ role: string; content: string }> {
  return [{ role: "system", content: systemPrompt }, ...messages];
}

/** 429/5xx は指数バックオフで最大 maxAttempts 回リトライする。
 * 402（残高不足）は専用のエラーとして即座に投げる（リトライしない）。
 * それ以外の 4xx は設定ミスとして即座に投げる（リトライしない）。 */
export function makeOpenRouterCaller(opts: OpenRouterOptions): CallModelFn {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 4;
  const maxTokens = opts.maxTokens ?? 1000;
  const apiKey = opts.apiKey;

  return async function callOpenRouter(args: CallModelArgs): Promise<string> {
    const payload = {
      model: args.model,
      messages: toOpenAiMessages(args.systemPrompt, args.messages),
      max_tokens: maxTokens,
    };

    let delayMs = 1000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetchFn(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.length === 0) {
          throw new Error("OpenRouterの応答にcontentがありません");
        }
        return content;
      }

      await res.body?.cancel().catch(() => {});

      if (res.status === 402) {
        throw new InsufficientBalanceError();
      }

      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`OpenRouterがエラーを返しました (status=${res.status})`);
      }
      await sleepFn(delayMs);
      delayMs *= 2;
    }
    throw new Error("unreachable");
  };
}
