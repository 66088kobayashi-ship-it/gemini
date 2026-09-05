import { assert, assertEquals } from "./test_util.ts";
import { InsufficientBalanceError, makeOpenRouterCaller } from "./openrouter.ts";
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
