import { assert, assertEquals, assertNotEquals } from "./test_util.ts";
import {
  AuthContext,
  HandleRunDeps,
  handleQuota,
  handleRun,
  PersistRunOutput,
  StoredRun,
} from "./http_handlers.ts";
import { CallModelFn, Plan, TranscriptEntry } from "./engine.ts";

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
    getRunById: async () => null, // 明示的にオーバーライドしない限り、再開の対象は無い
    callModel: fn,
    dailyLimit: 50,
    ...overrides,
  };
}

function makeResumeBody(runId: string, addedRounds: number): unknown {
  return { resume: { runId, addedRounds } };
}

function makeStoredRun(overrides: Partial<StoredRun> = {}): StoredRun {
  const priorTranscript: TranscriptEntry[] = [
    { participantId: "boss", role: "boss", label: "指示", text: "新製品の告知文を書いてほしい" },
    { participantId: "loop:0", role: "propose", label: "提案", text: "前回の提案" },
    { participantId: "loop:1", role: "critic", label: "批判", text: "前回の批判" },
  ];
  return {
    plan: {
      before: [],
      loop: [
        { role: "propose", model: "openrouter/free-a" },
        { role: "critic", model: "openrouter/free-b" },
      ],
      after: [],
      rounds: 3,
      criteria: "根拠のない主張を残さない",
      instruction: "新製品の告知文を書いてほしい",
    },
    transcript: priorTranscript,
    verdict: null, // 周回上限に達して終わった実行（PASSではない）
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

// ---------------------------------------------------------------------------
// /run の再開（resume）: 周回上限で終わった実行だけを続きから実行できる
// ---------------------------------------------------------------------------

Deno.test("handleRun: 再開はJWT/allowlistより後に判定される（未認証はgetRunByIdを呼ばない）", async () => {
  let getRunByIdCalls = 0;
  const deps = baseDeps({
    verifyJwt: async () => null,
    getRunById: async () => {
      getRunByIdCalls++;
      return makeStoredRun();
    },
  });
  const res = await handleRun(null, makeResumeBody("run-1", 2), deps);
  assertEquals(res.status, 401);
  assertEquals(getRunByIdCalls, 0);
});

Deno.test("handleRun: allowlist外の再開要求はgetRunByIdを呼ばずに403", async () => {
  let getRunByIdCalls = 0;
  const deps = baseDeps({
    isAllowlisted: async () => false,
    getRunById: async () => {
      getRunByIdCalls++;
      return makeStoredRun();
    },
  });
  const res = await handleRun("Bearer good-jwt", makeResumeBody("run-1", 2), deps);
  assertEquals(res.status, 403);
  assertEquals(getRunByIdCalls, 0);
});

Deno.test("handleRun: 他人の実行ID・存在しない実行IDでの再開は404、呼び出し0回", async () => {
  const { fn, count } = countingCallModel();
  const deps = baseDeps({ getRunById: async () => null, callModel: fn });
  const res = await handleRun("Bearer good-jwt", makeResumeBody("not-mine-or-missing", 2), deps);
  assertEquals(res.status, 404);
  assertEquals(count(), 0);
});

Deno.test("handleRun: PASSで終わった実行の再開要求は400、呼び出し0回", async () => {
  const { fn, count } = countingCallModel();
  const deps = baseDeps({
    getRunById: async () => makeStoredRun({ verdict: "PASS" }),
    callModel: fn,
  });
  const res = await handleRun("Bearer good-jwt", makeResumeBody("run-1", 2), deps);
  assertEquals(res.status, 400);
  assertEquals(count(), 0);
});

Deno.test("handleRun: FAIL/nullで終わった実行はどちらも再開できる（200）", async () => {
  for (const verdict of ["FAIL", null] as const) {
    const deps = baseDeps({ getRunById: async () => makeStoredRun({ verdict }) });
    const res = await handleRun("Bearer good-jwt", makeResumeBody("run-1", 1), deps);
    assertEquals(res.status, 200, `verdict=${verdict} で再開できるべき`);
  }
});

Deno.test("handleRun: 再開の消費回数は「追加周回数×人数」のみ（前回ぶんを含まない）", async () => {
  const persisted: Array<{ callsActual: number; callsPlanned: number }> = [];
  const stored = makeStoredRun(); // loop長 2
  const deps = baseDeps({
    getRunById: async () => stored,
    persistRun: async (input) => {
      persisted.push({ callsActual: input.callsActual, callsPlanned: input.callsPlanned });
      return { ok: true, runId: "run-2" };
    },
  });
  const res = await handleRun("Bearer good-jwt", makeResumeBody("run-1", 4), deps);
  assertEquals(res.status, 200);
  assertEquals(persisted.length, 1);
  // 4周 × 2人 = 8回。前回のtranscript(3件)の長さとは無関係。
  assertEquals(persisted[0].callsActual, 8);
  assertEquals(persisted[0].callsPlanned, 8);
  const body = res.body as { callsActual: number; callsPlanned: number };
  assertEquals(body.callsActual, 8);
  assertEquals(body.callsPlanned, 8);
});

Deno.test("handleRun: 再開でクライアントが calls を偽って送っても無視される", async () => {
  const stored = makeStoredRun();
  const deps = baseDeps({ getRunById: async () => stored });
  const body = makeResumeBody("run-1", 4) as Record<string, unknown>;
  body.calls = 1; // 嘘の申告
  const res = await handleRun("Bearer good-jwt", body, deps);
  assertEquals(res.status, 200);
  assertEquals((res.body as { callsActual: number }).callsActual, 8);
});

Deno.test("handleRun: 再開時、残量不足なら409で実行されない", async () => {
  const { fn, count } = countingCallModel();
  const stored = makeStoredRun(); // loop長2 -> 4周で8回必要
  const deps = baseDeps({
    getRunById: async () => stored,
    getUsedToday: async () => 45,
    dailyLimit: 50, // 残り5回しかない
    callModel: fn,
  });
  const res = await handleRun("Bearer good-jwt", makeResumeBody("run-1", 4), deps);
  assertEquals(res.status, 409);
  assertEquals(count(), 0);
});

Deno.test("handleRun: 再開時、前回のtranscriptが新しいtranscriptの先頭に引き継がれ、instructionは重複しない", async () => {
  const stored = makeStoredRun();
  const deps = baseDeps({ getRunById: async () => stored });
  const res = await handleRun("Bearer good-jwt", makeResumeBody("run-1", 1), deps);
  assertEquals(res.status, 200);
  const body = res.body as { transcript: TranscriptEntry[] };
  // 前回の3件（boss含む） + 今回の2件（loop長2 × 1周）= 5件
  assertEquals(body.transcript.length, 5);
  assertEquals(body.transcript[0].participantId, "boss");
  assertEquals(body.transcript[1].text, "前回の提案");
  assertEquals(body.transcript[2].text, "前回の批判");
  // bossの発言は先頭の1件だけ（再挿入されていない）
  const bossEntries = body.transcript.filter((e) => e.participantId === "boss");
  assertEquals(bossEntries.length, 1);
});

Deno.test("handleRun: 再開時もAPIに渡される配列の先頭は必ず他人の発言になる", async () => {
  // 過去に何周も回った長いtranscriptを模し、再開後の各呼び出しでモデルに
  // 渡されるmessagesの先頭がuser（他人の発言）であることを確認する。
  const longPriorTranscript: TranscriptEntry[] = [
    { participantId: "boss", role: "boss", label: "指示", text: "書いて" },
  ];
  for (let r = 0; r < 5; r++) {
    longPriorTranscript.push(
      { participantId: "loop:0", role: "propose", label: "提案", text: `propose-${r}` },
      { participantId: "loop:1", role: "critic", label: "批判", text: `critic-${r}` },
    );
  }
  const stored = makeStoredRun({ transcript: longPriorTranscript });
  const seenFirstRoles: string[] = [];
  const callModel: CallModelFn = async ({ messages }) => {
    if (messages.length > 0) seenFirstRoles.push(messages[0].role);
    return "続きの応答";
  };
  const deps = baseDeps({ getRunById: async () => stored, callModel });
  const res = await handleRun("Bearer good-jwt", makeResumeBody("run-1", 2), deps);
  assertEquals(res.status, 200);
  assert(seenFirstRoles.length > 0);
  for (const role of seenFirstRoles) {
    assertEquals(role, "user", "再開後の呼び出しで先頭が自分の発言(assistant)になっている");
  }
});

Deno.test("handleRun: plan と resume の両方/どちらも無い場合は400、getRunByIdもcallModelも呼ばない", async () => {
  const { fn, count } = countingCallModel();
  let getRunByIdCalls = 0;
  const deps = baseDeps({
    getRunById: async () => {
      getRunByIdCalls++;
      return null;
    },
    callModel: fn,
  });
  const bothRes = await handleRun(
    "Bearer good-jwt",
    { plan: (makePlanBody() as { plan: Plan }).plan, resume: { runId: "x", addedRounds: 1 } },
    deps,
  );
  const neitherRes = await handleRun("Bearer good-jwt", {}, deps);
  assertEquals(bothRes.status, 400);
  assertEquals(neitherRes.status, 400);
  assertEquals(getRunByIdCalls, 0);
  assertEquals(count(), 0);
});

Deno.test("handleRun: 再開でも429/402/401とは別に、PASS拒否(400)・未検出(404)がそれぞれ別ステータスになる", async () => {
  const passDeps = baseDeps({ getRunById: async () => makeStoredRun({ verdict: "PASS" }) });
  const missingDeps = baseDeps({ getRunById: async () => null });
  const passRes = await handleRun("Bearer good-jwt", makeResumeBody("run-1", 1), passDeps);
  const missingRes = await handleRun("Bearer good-jwt", makeResumeBody("run-1", 1), missingDeps);
  assertEquals(passRes.status, 400);
  assertEquals(missingRes.status, 404);
  assertNotEquals(passRes.status, missingRes.status);
});
