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

/** リトライを使い切った429（無料モデルの共有枠での混雑）。
 * 402（残高不足）や404（モデルID誤り）とは原因が違うので、専用の型にする。 */
export class RateLimitedError extends Error {
  constructor(message = "OpenRouterが混み合っている") {
    super(message);
    this.name = "RateLimitedError";
  }
}

/** content が空だったときの診断情報。キー・トークンの中身は一切含めない
 * （finish_reason・messageのキー名一覧・トークン数のみ）。 */
export interface ResponseDiagnostics {
  finishReason: string | null;
  messageKeys: string[];
  usage: unknown;
}

/** HTTP 200 のままボディのトップレベルに error を含めて返してくる場合がある
 * （上流プロバイダ側の失敗などをOpenRouterがそのまま透過するケース）。
 * choices抽出より前に検出し、専用のエラーにする。
 * error.message / error.code のみを含める（キー・トークンはそもそもこの
 * フィールドに含まれ得ない値なので、含めても漏えいにはならない）。 */
export class UpstreamErrorResponse extends Error {
  code: string | number | null;
  upstreamMessage: string | null;
  constructor(upstreamError: { message?: unknown; code?: unknown }) {
    const upstreamMessage = typeof upstreamError?.message === "string" ? upstreamError.message : null;
    const code = typeof upstreamError?.code === "string" || typeof upstreamError?.code === "number"
      ? upstreamError.code
      : null;
    super(
      `OpenRouterが200応答の中にエラーを含めました (code=${code}): ${upstreamMessage ?? "詳細不明"}`,
    );
    this.name = "UpstreamErrorResponse";
    this.code = code;
    this.upstreamMessage = upstreamMessage;
  }
}

/** finish_reason === "length"（max_tokens不足で本文が出る前に打ち切られた）。
 * モデルの故障ではないので、空応答一般とは別のエラーにする。 */
export class TruncatedResponseError extends Error {
  finishReason: string | null;
  usage: unknown;
  constructor(d: ResponseDiagnostics) {
    super(
      `OpenRouterの応答が途中で打ち切られました (finish_reason=${d.finishReason})。` +
        `max_tokensが不足している可能性があります。usage=${JSON.stringify(d.usage)}`,
    );
    this.name = "TruncatedResponseError";
    this.finishReason = d.finishReason;
    this.usage = d.usage;
  }
}

/** content が空（truncation以外の原因）。推論モデルが message.reasoning
 * にしか本文を返していない場合は reasoningOnly を立てて区別する
 * （reasoning を content の代わりに使うことはしない。指示や検収の
 * 判定材料は最終回答であるべきで、内部の思考過程を紛れ込ませたくない）。 */
export class EmptyResponseError extends Error {
  finishReason: string | null;
  messageKeys: string[];
  usage: unknown;
  reasoningOnly: boolean;
  /** true: choices自体が空/欠落（モデルが選択肢を一つも返さなかった）。
   * false: choices[0]は存在するが、その中のmessageが空オブジェクト等で
   * content が取れなかった。原因が違うので区別できるようにする。 */
  choicesEmpty: boolean;
  constructor(d: ResponseDiagnostics & { reasoningOnly: boolean; choicesEmpty: boolean }) {
    const choicesNote = d.choicesEmpty
      ? "choicesが空でした（モデルが応答そのものを生成しませんでした）。"
      : (d.messageKeys.length === 0 ? "messageが空オブジェクトでした。" : "");
    const reasoningNote = d.reasoningOnly
      ? "message.reasoningのみが返り、contentが空でした（推論モデルが本文を出していません）。"
      : "";
    super(
      `OpenRouterの応答にcontentがありません。${choicesNote}${reasoningNote}` +
        `finish_reason=${d.finishReason}, messageのキー=[${d.messageKeys.join(", ")}], ` +
        `usage=${JSON.stringify(d.usage)}`,
    );
    this.name = "EmptyResponseError";
    this.finishReason = d.finishReason;
    this.messageKeys = d.messageKeys;
    this.usage = d.usage;
    this.reasoningOnly = d.reasoningOnly;
    this.choicesEmpty = d.choicesEmpty;
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

        // OpenRouterはHTTP 200のままボディのトップレベルにerrorを含めて返す
        // ことがある（上流プロバイダ側の失敗を透過するケース）。choicesの
        // 抽出より前に検出する。
        if (data?.error) {
          throw new UpstreamErrorResponse(data.error);
        }

        const choice = data?.choices?.[0];
        const choicesEmpty = !choice;
        const message = choice?.message ?? {};
        const finishReason: string | null = choice?.finish_reason ?? null;
        const usage = data?.usage ?? null;
        const messageKeys = message && typeof message === "object" ? Object.keys(message) : [];
        const content = typeof message.content === "string" ? message.content : "";

        if (content.length > 0) {
          return content;
        }

        if (finishReason === "length") {
          throw new TruncatedResponseError({ finishReason, messageKeys, usage });
        }

        const reasoningOnly = typeof message.reasoning === "string" && message.reasoning.length > 0;
        throw new EmptyResponseError({ finishReason, messageKeys, usage, reasoningOnly, choicesEmpty });
      }

      await res.body?.cancel().catch(() => {});

      if (res.status === 402) {
        throw new InsufficientBalanceError();
      }

      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!retryable || attempt === maxAttempts) {
        if (res.status === 429) {
          throw new RateLimitedError();
        }
        throw new Error(`OpenRouterがエラーを返しました (status=${res.status})`);
      }
      await sleepFn(delayMs);
      delayMs *= 2;
    }
    throw new Error("unreachable");
  };
}
