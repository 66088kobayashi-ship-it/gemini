import { assert, assertEquals } from "./test_util.ts";
import {
  AuthContext,
  HandleRunDeps,
  handleQuota,
  handleRun,
  PersistRunOutput,
} from "./http_handlers.ts";
import { CallModelFn, Plan } from "./engine.ts";

const OK_AUTH: AuthContext = { userId: "user-1", email: "ok@example.com" };

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

function baseDeps(overrides: Partial<HandleRunDeps> = {}): HandleRunDeps {
  const { fn } = countingCallModel();
  return {
    verifyJwt: async () => OK_AUTH,
    isAllowlisted: async () => true,
    getUsedToday: async () => 0,
    persistRun: async () => ({ ok: true, runId: "run-1" }),
    callModel: fn,
    dailyLimit: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// デプロイ前の確認: いずれも OpenRouter (callModel) を1回も呼ばずに返ること
// ---------------------------------------------------------------------------

Deno.test("handleRun: JWTなし -> 401, 呼び出し0回", async () => {
  const { fn, count } = countingCallModel();
  const deps = baseDeps({ verifyJwt: async () => null, callModel: fn });
  const res = await handleRun("", makePlanBody(), deps);
  assertEquals(res.status, 401);
  assertEquals(count(), 0);
});

Deno.test("handleRun: allowlistにないユーザー -> 403, 呼び出し0回", async () => {
  const { fn, count } = countingCallModel();
  const deps = baseDeps({ isAllowlisted: async () => false, callModel: fn });
  const res = await handleRun("Bearer good-jwt", makePlanBody(), deps);
  assertEquals(res.status, 403);
  assertEquals(count(), 0);
});

Deno.test("handleRun: criteriaが空 -> 400, 呼び出し0回", async () => {
  const { fn, count } = countingCallModel();
  const deps = baseDeps({ callModel: fn });
  const res = await handleRun("Bearer good-jwt", makePlanBody({ criteria: "" }), deps);
  assertEquals(res.status, 400);
  assertEquals(count(), 0);
});

Deno.test("handleRun: instructionが空 -> 400, 呼び出し0回", async () => {
  const { fn, count } = countingCallModel();
  const deps = baseDeps({ callModel: fn });
  const res = await handleRun("Bearer good-jwt", makePlanBody({ instruction: "" }), deps);
  assertEquals(res.status, 400);
  assertEquals(count(), 0);
});

Deno.test("handleRun: リクエストボディのinstructionが正しくPlanへ渡る", async () => {
  const plan = makePlanBody({ instruction: "新製品の告知文を書いてほしい" }) as {
    plan: { instruction: string };
  };
  let seenInstruction: string | null = null;
  const deps = baseDeps({
    persistRun: async (input) => {
      seenInstruction = input.plan.instruction;
      return { ok: true, runId: "run-1" };
    },
  });
  const res = await handleRun("Bearer good-jwt", plan, deps);
  assertEquals(res.status, 200);
  assertEquals(seenInstruction, "新製品の告知文を書いてほしい");
});

Deno.test("handleRun: 残量不足 -> 409, 呼び出し0回, persistRunも呼ばれない", async () => {
  const { fn, count } = countingCallModel();
  let persistCalls = 0;
  const deps = baseDeps({
    getUsedToday: async () => 49,
    dailyLimit: 50,
    callModel: fn,
    persistRun: async () => {
      persistCalls++;
      return { ok: true, runId: "run-1" };
    },
  }); // 6回必要、残り1回
  const res = await handleRun("Bearer good-jwt", makePlanBody(), deps);
  assertEquals(res.status, 409);
  assertEquals(count(), 0);
  assertEquals(persistCalls, 0);
});

Deno.test("handleRun: クライアントが calls:1 と偽って送っても、サーバー再計算値で判定する", async () => {
  const { fn, count } = countingCallModel();
  const deps = baseDeps({ getUsedToday: async () => 49, dailyLimit: 50, callModel: fn });
  const body = makePlanBody() as Record<string, unknown>;
  body.calls = 1; // 嘘の申告（handleRunはこのフィールドを読まない）
  const res = await handleRun("Bearer good-jwt", body, deps);
  assertEquals(res.status, 409); // 実際は6回必要なので、1回だと判定されていない
  assertEquals(count(), 0);
  assertEquals((res.body as { needed: number }).needed, 6);
});

// ---------------------------------------------------------------------------
// 正常系・検収PASS早期終了・記録失敗の握りつぶし防止
// ---------------------------------------------------------------------------

Deno.test("handleRun: 正常実行で実際の呼び出し回数がpersistRunに渡る", async () => {
  const persisted: Array<{ callsActual: number; callsPlanned: number }> = [];
  const deps = baseDeps({
    persistRun: async (input) => {
      persisted.push({ callsActual: input.callsActual, callsPlanned: input.callsPlanned });
      return { ok: true, runId: "run-1" };
    },
  });
  const res = await handleRun("Bearer good-jwt", makePlanBody({ rounds: 3 }), deps);
  assertEquals(res.status, 200);
  assertEquals(persisted.length, 1);
  assertEquals(persisted[0].callsActual, 6);
  assertEquals(persisted[0].callsPlanned, 6);
});

Deno.test("handleRun: 検収PASSで早期終了した場合、persistRunに渡るのは実際の呼び出し回数", async () => {
  const persisted: Array<{ callsActual: number; callsPlanned: number }> = [];
  const callModel: CallModelFn = async ({ systemPrompt }) =>
    systemPrompt.includes("検収") ? "PASS" : "応答";
  const deps = baseDeps({
    callModel,
    persistRun: async (input) => {
      persisted.push({ callsActual: input.callsActual, callsPlanned: input.callsPlanned });
      return { ok: true, runId: "run-1" };
    },
  });
  const plan = makePlanBody({
    loop: [
      { role: "propose", model: "m" },
      { role: "check", model: "m" },
    ],
    rounds: 10,
  });
  const res = await handleRun("Bearer good-jwt", plan, deps);
  assertEquals(res.status, 200);
  assertEquals(persisted[0].callsActual, 2); // 20ではない
  assertEquals(persisted[0].callsPlanned, 20);
});

Deno.test("handleRun: 加算(persistRun)が失敗したら、黙って200成功にしない", async () => {
  const failing: PersistRunOutput = { ok: false, error: "db down" };
  const deps = baseDeps({ persistRun: async () => failing });
  const res = await handleRun("Bearer good-jwt", makePlanBody(), deps);
  assert(res.status !== 200, "記録失敗なのに200を返している");
  assert(String(res.body.warning ?? "").length > 0, "warningフィールドが無い");
});

// ---------------------------------------------------------------------------
// /quota
// ---------------------------------------------------------------------------

Deno.test("handleQuota: JWTなし -> 401", async () => {
  const res = await handleQuota(null, {
    verifyJwt: async () => null,
    getUsedToday: async () => 0,
    dailyLimit: 50,
  });
  assertEquals(res.status, 401);
});

Deno.test("handleQuota: 正常系で used/limit/remaining を返す", async () => {
  const res = await handleQuota("Bearer good-jwt", {
    verifyJwt: async () => OK_AUTH,
    getUsedToday: async () => 12,
    dailyLimit: 50,
  });
  assertEquals(res.status, 200);
  assertEquals(res.body, { used: 12, limit: 50, remaining: 38 });
});
