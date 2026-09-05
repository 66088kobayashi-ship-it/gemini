import { assert, assertEquals, assertNotEquals } from "./test_util.ts";
import {
  EmptyResponseError,
  InsufficientBalanceError,
  makeOpenRouterCaller,
  RateLimitedError,
  TruncatedResponseError,
} from "./openrouter.ts";
import type { CallModelArgs } from "./engine.ts";

const SECRET_KEY = "sk-or-v1-super-secret-do-not-leak";

function args(): CallModelArgs {
  return {
    systemPrompt: "あなたは提案役です。",
    messages: [{ role: "user", content: "こんにちは" }],
    model: "openrouter/free-a",
  };
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

Deno.test("openrouter: 成功時は choices[0].message.content を返す", async () => {
  let calls = 0;
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    const payload = JSON.parse(String(init?.body));
    assertEquals(payload.model, "openrouter/free-a");
    assertEquals(payload.messages[0], { role: "system", content: "あなたは提案役です。" });
    return jsonRes(200, { choices: [{ message: { content: "応答本文" } }] });
  };
  const call = makeOpenRouterCaller({
    apiKey: SECRET_KEY,
    fetchFn,
    sleepFn: async () => {},
  });
  const text = await call(args());
  assertEquals(text, "応答本文");
  assertEquals(calls, 1);
});

Deno.test("openrouter: APIキーはヘッダにのみ載り、他には出ない", async () => {
  let sawAuthHeader = "";
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    sawAuthHeader = headers["Authorization"];
    return jsonRes(200, { choices: [{ message: { content: "ok" } }] });
  };
  const call = makeOpenRouterCaller({ apiKey: SECRET_KEY, fetchFn, sleepFn: async () => {} });
  await call(args());
  assertEquals(sawAuthHeader, `Bearer ${SECRET_KEY}`);
});

Deno.test("openrouter: 402は専用エラーで即座に投げる（リトライしない）", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return jsonRes(402, { error: "insufficient balance" });
  };
  const call = makeOpenRouterCaller({ apiKey: SECRET_KEY, fetchFn, sleepFn: async () => {} });
  let threw = false;
  try {
    await call(args());
  } catch (e) {
    threw = true;
    assert(e instanceof InsufficientBalanceError);
    assert(!String((e as Error).message).includes(SECRET_KEY));
  }
  assert(threw);
  assertEquals(calls, 1);
});

Deno.test("openrouter: 429は指数バックオフでリトライし、最終的に成功する", async () => {
  let calls = 0;
  const delays: number[] = [];
  const fetchFn = async () => {
    calls++;
    if (calls < 3) return jsonRes(429, { error: "rate limited" });
    return jsonRes(200, { choices: [{ message: { content: "3回目で成功" } }] });
  };
  const call = makeOpenRouterCaller({
    apiKey: SECRET_KEY,
    fetchFn,
    sleepFn: async (ms: number) => {
      delays.push(ms);
    },
  });
  const text = await call(args());
  assertEquals(text, "3回目で成功");
  assertEquals(calls, 3);
  assertEquals(delays, [1000, 2000]);
});

Deno.test("openrouter: 5xxは最大4回リトライした後に失敗する", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return jsonRes(503, { error: "unavailable" });
  };
  const call = makeOpenRouterCaller({ apiKey: SECRET_KEY, fetchFn, sleepFn: async () => {} });
  let threw = false;
  try {
    await call(args());
  } catch (e) {
    threw = true;
    assert(!String((e as Error).message).includes(SECRET_KEY));
  }
  assert(threw);
  assertEquals(calls, 4);
});

Deno.test("openrouter: 400は即座に失敗する（リトライしない）", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return jsonRes(400, { error: "bad request: unknown model" });
  };
  const call = makeOpenRouterCaller({ apiKey: SECRET_KEY, fetchFn, sleepFn: async () => {} });
  let threw = false;
  try {
    await call(args());
  } catch (e) {
    threw = true;
    assert(!String((e as Error).message).includes(SECRET_KEY));
  }
  assert(threw);
  assertEquals(calls, 1);
});

// ---------------------------------------------------------------------------
// content が空: 診断情報（finish_reason・messageのキー一覧・usage）
// ---------------------------------------------------------------------------

Deno.test("openrouter: contentが空だと、finish_reasonとmessageのキー一覧を含むエラーになる", async () => {
  const fetchFn = async () =>
    jsonRes(200, {
      choices: [{ message: { role: "assistant", refusal: null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    });
  const call = makeOpenRouterCaller({ apiKey: SECRET_KEY, fetchFn, sleepFn: async () => {} });
  let caught: unknown;
  try {
    await call(args());
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof EmptyResponseError);
  const err = caught as EmptyResponseError;
  assertEquals(err.finishReason, "stop");
  assertEquals(err.messageKeys, ["role", "refusal"]);
  assert(err.message.includes("finish_reason=stop"));
  assert(err.message.includes("role"));
  assert(err.message.includes("refusal"));
});

Deno.test("openrouter: finish_reason=lengthは専用のTruncatedResponseErrorになる", async () => {
  const fetchFn = async () =>
    jsonRes(200, {
      choices: [{ message: { role: "assistant" }, finish_reason: "length" }],
      usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 },
    });
  const call = makeOpenRouterCaller({ apiKey: SECRET_KEY, fetchFn, sleepFn: async () => {} });
  let caught: unknown;
  try {
    await call(args());
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof TruncatedResponseError);
  assert(!(caught instanceof EmptyResponseError), "lengthは空応答一般とは別のエラー型であるべき");
  const err = caught as TruncatedResponseError;
  assertEquals(err.finishReason, "length");
  assert(err.message.includes("length"));
});

Deno.test("openrouter: reasoningのみでcontentが空の場合、reasoningOnlyで区別される", async () => {
  const fetchFn = async () =>
    jsonRes(200, {
      choices: [{
        message: { role: "assistant", reasoning: "内部の思考の長い文章…" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 },
    });
  const call = makeOpenRouterCaller({ apiKey: SECRET_KEY, fetchFn, sleepFn: async () => {} });
  let caught: unknown;
  try {
    await call(args());
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof EmptyResponseError);
  const err = caught as EmptyResponseError;
  assertEquals(err.reasoningOnly, true);
  assert(err.message.includes("reasoning"));
});

Deno.test("openrouter: reasoningもcontentも無い空応答はreasoningOnly=falseになる", async () => {
  const fetchFn = async () =>
    jsonRes(200, { choices: [{ message: { role: "assistant" }, finish_reason: "stop" }] });
  const call = makeOpenRouterCaller({ apiKey: SECRET_KEY, fetchFn, sleepFn: async () => {} });
  let caught: unknown;
  try {
    await call(args());
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof EmptyResponseError);
  assertEquals((caught as EmptyResponseError).reasoningOnly, false);
});

Deno.test("openrouter: content/truncationの診断エラーにキーの中身が含まれない", async () => {
  const fetchFn = async () =>
    jsonRes(200, {
      choices: [{
        message: { role: "assistant", reasoning: "何かの思考テキスト" },
        finish_reason: "length",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  const call = makeOpenRouterCaller({ apiKey: SECRET_KEY, fetchFn, sleepFn: async () => {} });
  let caught: unknown;
  try {
    await call(args());
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof Error);
  assert(!(caught as Error).message.includes(SECRET_KEY));
});

// ---------------------------------------------------------------------------
// 429: リトライ枯渇後は専用のRateLimitedErrorになる（402/404/500とは別）
// ---------------------------------------------------------------------------

Deno.test("openrouter: リトライを使い切った429は専用のRateLimitedErrorになる", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return jsonRes(429, { error: "rate limited" });
  };
  const call = makeOpenRouterCaller({ apiKey: SECRET_KEY, fetchFn, sleepFn: async () => {} });
  let caught: unknown;
  try {
    await call(args());
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof RateLimitedError);
  assert(!(caught instanceof InsufficientBalanceError));
  assertEquals(calls, 4);
  assert(!(caught as Error).message.includes(SECRET_KEY));
});

Deno.test("openrouter: RateLimitedErrorは402(残高不足)や5xxの汎用エラーとは別の型になる", async () => {
  const rateLimited = await (async () => {
    const fetchFn = async () => jsonRes(429, {});
    const call = makeOpenRouterCaller({ apiKey: SECRET_KEY, fetchFn, sleepFn: async () => {} });
    try {
      await call(args());
    } catch (e) {
      return e as Error;
    }
    throw new Error("should have thrown");
  })();
  const balance = await (async () => {
    const fetchFn = async () => jsonRes(402, {});
    const call = makeOpenRouterCaller({ apiKey: SECRET_KEY, fetchFn, sleepFn: async () => {} });
    try {
      await call(args());
    } catch (e) {
      return e as Error;
    }
    throw new Error("should have thrown");
  })();
  assert(rateLimited instanceof RateLimitedError);
  assert(balance instanceof InsufficientBalanceError);
  assertNotEquals(rateLimited.constructor, balance.constructor);
  assertNotEquals(rateLimited.message, balance.message);
});
