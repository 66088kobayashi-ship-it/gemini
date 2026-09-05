// これが今回のバグの再発防止テスト本体。
// OPENROUTER_API_KEY が「未設定」の環境を模して、Deno.serve コールバック
// （handleRunRequest）を直接呼ぶ。JWT/allowlist/criteria/instruction/残量の
// 判定が、OpenRouterキーの有無より必ず先に効くことを検証する。
import { assert, assertEquals } from "../_shared/test_util.ts";
import { handleRunRequest, RunDeps } from "./handler.ts";
import { AuthContext } from "../_shared/http_handlers.ts";
import { CallModelFn, Plan } from "../_shared/engine.ts";

const OK_AUTH: AuthContext = { userId: "user-1", email: "ok@example.com" };
const NO_KEY_ENV = (_name: string): string | undefined => undefined;

function makePlanBody(overrides: Partial<Plan> = {}): unknown {
  const plan: Plan = {
    before: [],
    loop: [
      { role: "propose", model: "openrouter/free-a" },
      { role: "critic", model: "openrouter/free-b" },
    ],
    after: [],
    rounds: 3,
    criteria: "根拠のない主張を残さない",
    instruction: "新製品の告知文を書いてほしい",
    ...overrides,
  };
  return { plan };
}

function countingCallModel(): { fn: CallModelFn; count: () => number } {
  let n = 0;
  const fn: CallModelFn = async () => {
    n++;
    return "応答";
  };
  return { fn, count: () => n };
}

function makeRequest(body: unknown, authHeader: string | null): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authHeader !== null) headers.set("Authorization", authHeader);
  return new Request("https://example.com/run", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function baseDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  const { fn } = countingCallModel();
  return {
    getEnv: NO_KEY_ENV, // OPENROUTER_API_KEY 未設定を模す
    verifyJwt: async () => OK_AUTH,
    isAllowlisted: async () => true,
    getUsedToday: async () => 0,
    persistRun: async () => ({ ok: true, runId: "run-1" }),
    callModel: fn,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// これが実際に起きたバグの再現テスト: キー未設定でも、
// allowlist外は403（500ではない）で弾かれる
// ---------------------------------------------------------------------------

Deno.test("handleRunRequest: キー未設定でも allowlist外は403（500ではない）、呼び出し0回", async () => {
  const { fn, count } = countingCallModel();
  const deps = baseDeps({ isAllowlisted: async () => false, callModel: fn });
  const res = await handleRunRequest(makeRequest(makePlanBody(), "Bearer good-jwt"), deps);
  assertEquals(res.status, 403);
  assertEquals(count(), 0);
});

Deno.test("handleRunRequest: キー未設定でも JWTなしは401、呼び出し0回", async () => {
  const { fn, count } = countingCallModel();
  const deps = baseDeps({ verifyJwt: async () => null, callModel: fn });
  const res = await handleRunRequest(makeRequest(makePlanBody(), null), deps);
  assertEquals(res.status, 401);
  assertEquals(count(), 0);
});

Deno.test("handleRunRequest: キー未設定でも criteria空は400、呼び出し0回", async () => {
  const { fn, count } = countingCallModel();
  const deps = baseDeps({ callModel: fn });
  const res = await handleRunRequest(
    makeRequest(makePlanBody({ criteria: "" }), "Bearer good-jwt"),
    deps,
  );
  assertEquals(res.status, 400);
  assertEquals(count(), 0);
});

Deno.test("handleRunRequest: キー未設定でも instruction空は400、呼び出し0回", async () => {
  const { fn, count } = countingCallModel();
  const deps = baseDeps({ callModel: fn });
  const res = await handleRunRequest(
    makeRequest(makePlanBody({ instruction: "" }), "Bearer good-jwt"),
    deps,
  );
  assertEquals(res.status, 400);
  assertEquals(count(), 0);
});

Deno.test("handleRunRequest: キー未設定でも残量不足は409、呼び出し0回", async () => {
  const { fn, count } = countingCallModel();
  const deps = baseDeps({ getUsedToday: async () => 49, callModel: fn }); // 6回必要、残り1回
  const res = await handleRunRequest(makeRequest(makePlanBody(), "Bearer good-jwt"), deps);
  assertEquals(res.status, 409);
  assertEquals(count(), 0);
});

// ---------------------------------------------------------------------------
// キー不足のエラーは、すべての判定を通過した後だけ発生する
// ---------------------------------------------------------------------------

Deno.test("handleRunRequest: 全判定を通過した場合にのみ、キー不足のエラー(500)になる", async () => {
  // callModel を注入せず、getEnv 由来の実アダプタ（遅延キー読み取り）を使わせる
  const deps: RunDeps = {
    getEnv: NO_KEY_ENV,
    verifyJwt: async () => OK_AUTH,
    isAllowlisted: async () => true,
    getUsedToday: async () => 0,
    persistRun: async () => ({ ok: true, runId: "run-1" }),
    // callModel を省略 -> makeLazyCallModel(getEnv) が使われ、実行時に例外を投げる
  };
  const res = await handleRunRequest(makeRequest(makePlanBody(), "Bearer good-jwt"), deps);
  assertEquals(res.status, 500);
});

Deno.test("handleRunRequest: モジュールのインポート自体はOPENROUTER_API_KEY未設定でも例外を投げない", async () => {
  const mod = await import("./handler.ts");
  assert(typeof mod.handleRunRequest === "function");
});

Deno.test("handleRunRequest: キーが設定されていれば正常系はそのまま動く（回帰確認）", async () => {
  const persisted: Array<{ callsActual: number }> = [];
  const deps = baseDeps({
    getEnv: (name: string) => (name === "OPENROUTER_API_KEY" ? "sk-dummy" : undefined),
    persistRun: async (input) => {
      persisted.push({ callsActual: input.callsActual });
      return { ok: true, runId: "run-1" };
    },
  });
  const res = await handleRunRequest(makeRequest(makePlanBody({ rounds: 1 }), "Bearer good-jwt"), deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.callsActual, 2);
  assertEquals(persisted.length, 1);
});
