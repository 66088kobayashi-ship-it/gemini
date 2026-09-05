import { assert, assertEquals, assertNotEquals } from "./test_util.ts";
import {
  BOSS_PARTICIPANT_ID,
  buildMessages,
  buildSystemPrompt,
  callsPlanned,
  CallModelFn,
  checkQuota,
  endReasonOf,
  executeRun,
  isResumable,
  Plan,
  runPlan,
  TranscriptEntry,
  utcDay,
  validatePlan,
} from "./engine.ts";

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    before: [],
    loop: [
      { role: "propose", model: "openrouter/free-a" },
      { role: "critic", model: "openrouter/free-b" },
    ],
    after: [],
    rounds: 3,
    criteria: "根拠のない主張を残さない／800字以内",
    instruction: "新製品の告知文を書いてほしい",
    ...overrides,
  };
}

function loopOf(n: number) {
  const roles = ["propose", "critic", "check", "research", "digest"];
  return Array.from({ length: n }, (_, i) => ({
    role: roles[i % roles.length],
    model: `openrouter/free-${i}`,
  }));
}

// ---------------------------------------------------------------------------
// 消費回数の一致（最重要）
// ---------------------------------------------------------------------------

Deno.test("callsPlanned matches loop x rounds across combinations", () => {
  for (const n of [2, 3, 5]) {
    for (const rounds of [1, 3, 10]) {
      const plan = makePlan({ loop: loopOf(n), rounds });
      assertEquals(callsPlanned(plan), n * rounds);
    }
  }
});

Deno.test("callsPlanned includes before/after (v2 pre-check)", () => {
  const plan = makePlan({
    before: [{ role: "research", model: "m" }],
    loop: loopOf(3),
    after: [{ role: "digest", model: "m" }],
    rounds: 4,
  });
  assertEquals(callsPlanned(plan), 1 + 3 * 4 + 1);
});

Deno.test("runPlan's actual call count matches callsPlanned when no early exit", async () => {
  for (const n of [2, 3, 5]) {
    for (const rounds of [1, 3, 10]) {
      const plan = makePlan({ loop: loopOf(n), rounds });
      let calls = 0;
      const callModel: CallModelFn = async () => {
        calls++;
        return "何かしらの応答";
      };
      const result = await runPlan(plan, { callModel });
      assertEquals(calls, callsPlanned(plan));
      assertEquals(result.callsActual, callsPlanned(plan));
    }
  }
});

Deno.test("runPlan honors before/after in actual call count (v2 pre-check)", async () => {
  const plan = makePlan({
    before: [{ role: "research", model: "m" }],
    loop: loopOf(2),
    after: [{ role: "digest", model: "m" }],
    rounds: 2,
  });
  let calls = 0;
  const callModel: CallModelFn = async () => {
    calls++;
    return "応答";
  };
  const result = await runPlan(plan, { callModel });
  assertEquals(calls, 1 + 2 * 2 + 1);
  assertEquals(result.callsActual, 1 + 2 * 2 + 1);
});

Deno.test("early PASS: actual calls is less than planned, not the plan value", async () => {
  const plan = makePlan({
    loop: [
      { role: "propose", model: "m" },
      { role: "critic", model: "m" },
      { role: "check", model: "m" },
    ],
    rounds: 5,
  });
  let calls = 0;
  const callModel: CallModelFn = async ({ systemPrompt }) => {
    calls++;
    if (systemPrompt.includes("検収")) return "PASS";
    return "応答";
  };
  const result = await runPlan(plan, { callModel });
  // 1周目で PASS するはずなので、3回だけ呼ばれる（15回ではない）
  assertEquals(calls, 3);
  assertEquals(result.callsActual, 3);
  assertNotEquals(result.callsActual, callsPlanned(plan));
  assertEquals(result.verdict, "PASS");
});

// ---------------------------------------------------------------------------
// 視点変換
// ---------------------------------------------------------------------------

Deno.test("buildMessages: self -> assistant, other -> user", () => {
  const plan = makePlan({ loop: loopOf(2) });
  const transcript: TranscriptEntry[] = [
    { participantId: "loop:1", role: "critic", label: "批判", text: "他人の発言1" },
    { participantId: "loop:0", role: "propose", label: "提案", text: "自分の発言1" },
  ];
  const messages = buildMessages(transcript, "loop:0", plan, 12);
  assertEquals(messages, [
    { role: "user", content: "他人の発言1" },
    { role: "assistant", content: "自分の発言1" },
  ]);
});

Deno.test("buildMessages: 3人以上のとき他人の発言に発言者名を前置する", () => {
  const plan = makePlan({ loop: loopOf(3) });
  const transcript: TranscriptEntry[] = [
    { participantId: "loop:1", role: "critic", label: "批判", text: "出典がない。" },
    { participantId: "loop:2", role: "check", label: "検収", text: "未達1件。" },
  ];
  const messages = buildMessages(transcript, "loop:0", plan, 12);
  assertEquals(messages[0].content, "[批判] 出典がない。");
  assertEquals(messages[1].content, "[検収] 未達1件。");
});

Deno.test("buildMessages: 2人のときは発言者名を付けない", () => {
  const plan = makePlan({ loop: loopOf(2) });
  const transcript: TranscriptEntry[] = [
    { participantId: "loop:1", role: "critic", label: "批判", text: "出典がない。" },
  ];
  const messages = buildMessages(transcript, "loop:0", plan, 12);
  assertEquals(messages[0].content, "出典がない。");
});

Deno.test("buildMessages: 全ターンで配列の先頭が他人の発言（窓を切り詰めても）", () => {
  const plan = makePlan({ loop: loopOf(3) });
  const participants = ["loop:0", "loop:1", "loop:2"];
  // 5周分の transcript をでっち上げる
  const transcript: TranscriptEntry[] = [];
  for (let r = 0; r < 5; r++) {
    for (const pid of participants) {
      transcript.push({ participantId: pid, role: pid, label: pid, text: `${pid}-${r}` });
    }
  }
  for (const window of [1, 2, 3, 4, 5, 6, 7, 12, 999]) {
    for (const me of participants) {
      const messages = buildMessages(transcript, me, plan, window);
      if (messages.length === 0) continue;
      assertEquals(
        messages[0].role,
        "user",
        `window=${window} me=${me} で先頭が assistant になった`,
      );
    }
  }
});

Deno.test("buildMessages: 窓のサイズを超えないこと", () => {
  const plan = makePlan({ loop: loopOf(2) });
  const transcript: TranscriptEntry[] = Array.from({ length: 20 }, (_, i) => ({
    participantId: i % 2 === 0 ? "loop:0" : "loop:1",
    role: i % 2 === 0 ? "propose" : "critic",
    label: i % 2 === 0 ? "提案" : "批判",
    text: `t${i}`,
  }));
  const messages = buildMessages(transcript, "loop:0", plan, 4);
  assert(messages.length <= 4);
});

Deno.test("runPlan: 全ターンの system prompt に条件の文字列が含まれる", async () => {
  const plan = makePlan({ loop: loopOf(3), rounds: 2, criteria: "一意なお題マーカーXYZ" });
  const seenPrompts: string[] = [];
  const callModel: CallModelFn = async ({ systemPrompt }) => {
    seenPrompts.push(systemPrompt);
    return "応答";
  };
  await runPlan(plan, { callModel });
  assert(seenPrompts.length > 0);
  for (const p of seenPrompts) {
    assert(p.includes("一意なお題マーカーXYZ"), `system prompt に条件が含まれない: ${p}`);
  }
});

Deno.test("buildSystemPrompt: 検収役は判定のみに縛られ、改善案を書かせる文言がない", () => {
  const plan = makePlan();
  const prompt = buildSystemPrompt(plan, "check");
  assert(prompt.includes("PASS"));
  assert(prompt.includes("FAIL"));
  assert(!prompt.includes("改善案を書"));
});

// ---------------------------------------------------------------------------
// instruction（何をしてほしいか）: criteria（どうなったら終わりか）とは別経路
// ---------------------------------------------------------------------------

Deno.test("runPlan: instruction が transcript の先頭に入り、role: user になる", async () => {
  const plan = makePlan({ loop: loopOf(2), instruction: "新製品の告知文を書いてほしい" });
  const callModel: CallModelFn = async () => "応答";
  const result = await runPlan(plan, { callModel });
  assertEquals(result.transcript[0].participantId, BOSS_PARTICIPANT_ID);
  assertEquals(result.transcript[0].text, "新製品の告知文を書いてほしい");

  // 1手目（loop:0）から見た messages の先頭が instruction で、role が user
  const messages = buildMessages([result.transcript[0]], "loop:0", plan, 12);
  assertEquals(messages[0].role, "user");
  assertEquals(messages[0].content.includes("新製品の告知文を書いてほしい"), true);
});

Deno.test("runPlan: instruction はAPI呼び出しに数えない（callsActualがずれない）", async () => {
  const plan = makePlan({ loop: loopOf(2), rounds: 3, instruction: "書いて" });
  let calls = 0;
  const callModel: CallModelFn = async () => {
    calls++;
    return "応答";
  };
  const result = await runPlan(plan, { callModel });
  assertEquals(calls, callsPlanned(plan));
  assertEquals(result.callsActual, callsPlanned(plan));
  // transcript には instruction 分の1件が追加で乗るので、callsActual とは一致しない
  assertEquals(result.transcript.length, callsPlanned(plan) + 1);
});

Deno.test("buildSystemPrompt: instruction は system prompt に含まれない（criteriaとは別経路）", () => {
  const plan = makePlan({
    criteria: "800字以内でまとめる",
    instruction: "新製品の告知文を書いてほしい",
  });
  const prompt = buildSystemPrompt(plan, "propose");
  assert(prompt.includes("800字以内でまとめる"), "criteriaが system prompt に無い");
  assert(!prompt.includes("新製品の告知文を書いてほしい"), "instructionが system prompt に漏れている");
});

Deno.test("criteria と instruction は結合されて1つの文字列になっていない", () => {
  const plan = makePlan({
    criteria: "800字以内でまとめる",
    instruction: "新製品の告知文を書いてほしい",
  });
  // 型レベルで別フィールド
  assertNotEquals(plan.criteria, plan.instruction);
  // instructionの実体（transcriptに乗る文字列）がcriteriaと結合されていない
  assertEquals(plan.instruction, "新製品の告知文を書いてほしい");
  assert(!plan.instruction.includes(plan.criteria));
});

Deno.test("buildMessages: 窓を切り詰めてinstructionが落ちても、先頭が自分の発言にならない", () => {
  const plan = makePlan({ loop: loopOf(3), instruction: "書いて" });
  const transcript: TranscriptEntry[] = [
    { participantId: BOSS_PARTICIPANT_ID, role: "boss", label: "指示", text: "書いて" },
  ];
  for (let r = 0; r < 5; r++) {
    for (const pid of ["loop:0", "loop:1", "loop:2"]) {
      transcript.push({ participantId: pid, role: pid, label: pid, text: `${pid}-${r}` });
    }
  }
  // window=1 は instruction を含む先頭要素を確実に切り落とす
  for (const window of [1, 2, 3]) {
    for (const me of ["loop:0", "loop:1", "loop:2"]) {
      const messages = buildMessages(transcript, me, plan, window);
      if (messages.length === 0) continue;
      assertEquals(messages[0].role, "user", `window=${window} me=${me}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 制御
// ---------------------------------------------------------------------------

Deno.test("executeRun: criteria が空だと invalid で、1回もAPIを呼ばない", async () => {
  const plan = makePlan({ criteria: "" });
  let calls = 0;
  const callModel: CallModelFn = async () => {
    calls++;
    return "応答";
  };
  const result = await executeRun(plan, 0, 50, callModel);
  assertEquals(result.kind, "invalid");
  assertEquals(calls, 0);
});

Deno.test("executeRun: instruction が空だと invalid で、1回もAPIを呼ばない", async () => {
  const plan = makePlan({ instruction: "" });
  let calls = 0;
  const callModel: CallModelFn = async () => {
    calls++;
    return "応答";
  };
  const result = await executeRun(plan, 0, 50, callModel);
  assertEquals(result.kind, "invalid");
  assertEquals(calls, 0);
});

Deno.test("validatePlan: instruction 空は 400", () => {
  const err = validatePlan(makePlan({ instruction: "   " }));
  assert(err !== null);
  assertEquals(err?.status, 400);
});

Deno.test("executeRun: 残量不足のとき quota_exceeded で、1回もAPIを呼ばない", async () => {
  const plan = makePlan({ loop: loopOf(3), rounds: 10 }); // 30回必要
  let calls = 0;
  const callModel: CallModelFn = async () => {
    calls++;
    return "応答";
  };
  const result = await executeRun(plan, 45, 50, callModel); // 残り5回しかない
  assertEquals(result.kind, "quota_exceeded");
  assertEquals(calls, 0);
});

Deno.test("executeRun: 検収役が PASS を返したらループが即座に終わる", async () => {
  const plan = makePlan({
    loop: [
      { role: "propose", model: "m" },
      { role: "check", model: "m" },
    ],
    rounds: 10,
  });
  const callModel: CallModelFn = async ({ systemPrompt }) =>
    systemPrompt.includes("検収") ? "PASS" : "応答";
  const result = await executeRun(plan, 0, 100, callModel);
  assert(result.kind === "ok");
  if (result.kind === "ok") {
    assertEquals(result.result.callsActual, 2);
    assertEquals(result.result.verdict, "PASS");
  }
});

Deno.test("executeRun: クライアントの calls 申告は無視し、サーバー側の再計算で判定する", async () => {
  // callsPlanned に相当する値をプラン外から渡す経路が存在しないことを、
  // 型シグネチャ自体で保証する（executeRun は Plan しか受け取らない）。
  // ここでは意図的に不正な「申告値」を模した引数を混ぜても影響しないことを確認する。
  const plan = makePlan({ loop: loopOf(3), rounds: 10 }); // 実際は30回必要
  const clientClaimedCalls = 1; // クライアントが偽って送ってきた値（使われない）
  let calls = 0;
  const callModel: CallModelFn = async () => {
    calls++;
    return "応答";
  };
  // 残り5回しかない状態で、実際に必要な30回に対して判定されることを確認
  const result = await executeRun(plan, 45, 50, callModel);
  assertEquals(result.kind, "quota_exceeded");
  if (result.kind === "quota_exceeded") {
    assertEquals(result.needed, 30);
    assertNotEquals(result.needed, clientClaimedCalls);
  }
  assertEquals(calls, 0);
});

Deno.test("checkQuota: calls > remaining は ok=false", () => {
  assertEquals(checkQuota(45, 50, 5), { ok: true, remaining: 5 });
  assertEquals(checkQuota(45, 50, 6), { ok: false, remaining: 5 });
});

Deno.test("validatePlan: criteria 空は 400", () => {
  const err = validatePlan(makePlan({ criteria: "  " }));
  assert(err !== null);
  assertEquals(err?.status, 400);
});

Deno.test("validatePlan: loop が空は 400", () => {
  const err = validatePlan(makePlan({ loop: [] }));
  assert(err !== null);
  assertEquals(err?.status, 400);
});

// ---------------------------------------------------------------------------
// 再開（priorTranscriptを渡して続きから実行する）
// ---------------------------------------------------------------------------

function priorTranscriptFixture(): TranscriptEntry[] {
  return [
    { participantId: BOSS_PARTICIPANT_ID, role: "boss", label: "指示", text: "新製品の告知文を書いてほしい" },
    { participantId: "loop:0", role: "propose", label: "提案", text: "前回の提案" },
    { participantId: "loop:1", role: "critic", label: "批判", text: "前回の批判" },
  ];
}

Deno.test("runPlan: priorTranscriptを渡すと続きから実行し、instructionを再挿入しない", async () => {
  const plan = makePlan({ loop: loopOf(2), rounds: 1 });
  const prior = priorTranscriptFixture();
  const callModel: CallModelFn = async () => "続きの応答";
  const result = await runPlan(plan, { callModel, priorTranscript: prior });

  // 前回の3件 + 今回の2件（loop長2 × 1周）= 5件
  assertEquals(result.transcript.length, 5);
  assertEquals(result.transcript[0], prior[0]);
  assertEquals(result.transcript[1], prior[1]);
  assertEquals(result.transcript[2], prior[2]);
  // bossの発言（instruction）は再挿入されず、1件のまま
  const bossEntries = result.transcript.filter((e) => e.participantId === BOSS_PARTICIPANT_ID);
  assertEquals(bossEntries.length, 1);
  // callsActualは今回の分だけ
  assertEquals(result.callsActual, 2);
});

Deno.test("runPlan: priorTranscriptが無い既存の呼び出しは、これまで通りinstructionを1回だけ積む（回帰確認）", async () => {
  const plan = makePlan({ loop: loopOf(2), rounds: 1, instruction: "書いて" });
  const callModel: CallModelFn = async () => "応答";
  const result = await runPlan(plan, { callModel });
  const bossEntries = result.transcript.filter((e) => e.participantId === BOSS_PARTICIPANT_ID);
  assertEquals(bossEntries.length, 1);
  assertEquals(result.transcript.length, 3); // boss1件 + loop2件
});

Deno.test("runPlan: priorTranscriptを引き継いでも、各呼び出しでmessagesの先頭は必ず他人の発言になる", async () => {
  const plan = makePlan({ loop: loopOf(2), rounds: 3 });
  // 過去5周ぶんの長いtranscriptをでっち上げる
  const prior: TranscriptEntry[] = [
    { participantId: BOSS_PARTICIPANT_ID, role: "boss", label: "指示", text: "書いて" },
  ];
  for (let r = 0; r < 5; r++) {
    prior.push(
      { participantId: "loop:0", role: "propose", label: "提案", text: `propose-${r}` },
      { participantId: "loop:1", role: "critic", label: "批判", text: `critic-${r}` },
    );
  }
  for (const window of [1, 2, 3, 4, 12]) {
    const seenFirstRoles: string[] = [];
    const callModel: CallModelFn = async ({ messages }) => {
      if (messages.length > 0) seenFirstRoles.push(messages[0].role);
      return "続き";
    };
    await runPlan(plan, { callModel, window, priorTranscript: [...prior] });
    for (const role of seenFirstRoles) {
      assertEquals(role, "user", `window=${window} で先頭がassistantになった`);
    }
  }
});

Deno.test("executeRun: priorTranscriptがあっても、消費回数は「追加ぶん」のPlanだけで再計算される", async () => {
  // 再開時のPlanはbefore/afterを空にし、loopとroundsだけを追加ぶんとして渡す
  // （呼び出し側の責務）。callsPlannedはその追加ぶんだけを返す。
  const plan = makePlan({ before: [], loop: loopOf(2), after: [], rounds: 4 });
  const prior = priorTranscriptFixture(); // 3件（前回ぶん。今回のcallsPlannedには無関係）
  let calls = 0;
  const callModel: CallModelFn = async () => {
    calls++;
    return "応答";
  };
  const result = await executeRun(plan, 0, 100, callModel, 12, prior);
  assert(result.kind === "ok");
  if (result.kind === "ok") {
    assertEquals(result.result.callsActual, 8); // 2人 × 4周
    assertEquals(calls, 8);
    assertEquals(result.result.transcript.length, prior.length + 8);
  }
});

Deno.test("isResumable: PASS以外（FAIL/null）はtrue、PASSはfalse", () => {
  assertEquals(isResumable("PASS"), false);
  assertEquals(isResumable("FAIL"), true);
  assertEquals(isResumable(null), true);
});

Deno.test("endReasonOf: PASS/FAIL/nullがそれぞれ別の終了理由になる", () => {
  const reasons = new Set([endReasonOf("PASS"), endReasonOf("FAIL"), endReasonOf(null)]);
  assertEquals(reasons.size, 3);
  assertEquals(endReasonOf("PASS"), "pass");
  assertEquals(endReasonOf("FAIL"), "failed");
  assertEquals(endReasonOf(null), "limit_reached");
});

// ---------------------------------------------------------------------------
// 日付境界（UTC）
// ---------------------------------------------------------------------------

Deno.test("utcDay: UTCの日付が変わるとリセットされる", () => {
  const before = utcDay(new Date("2026-09-04T23:59:59Z"));
  const after = utcDay(new Date("2026-09-05T00:00:01Z"));
  assertEquals(before, "2026-09-04");
  assertEquals(after, "2026-09-05");
  assertNotEquals(before, after);
});

Deno.test("utcDay: JSTの0時ではリセットされない（UTC 15:00 相当）", () => {
  // JST 2026-09-05 00:00:01 は UTC 2026-09-04 15:00:01
  const jstMidnight = utcDay(new Date("2026-09-04T15:00:01Z"));
  assertEquals(jstMidnight, "2026-09-04");
});
