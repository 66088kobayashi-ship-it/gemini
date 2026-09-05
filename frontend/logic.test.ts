import { assert, assertEquals, assertNotEquals, assertThrows } from "../supabase/functions/_shared/test_util.ts";
import {
  applyModelConfig,
  buildRedirectTo,
  buildRunBody,
  canSubmit,
  composeRunRequest,
  extractOAuthErrorText,
  groupByLap,
  interpretRunResponse,
  mapErrorMessage,
  mapOAuthError,
  stripBossEntry,
  validateSupabaseUrl,
} from "./logic.js";

// 既存のマジックリンクのエラー文言（index.html に直書き、壊していないことの
// 比較対象として使う。マジックリンクの経路自体は変更していない）。
const MAGIC_LINK_ERROR_TEXT = "送信できなかった。もう一度試す";

// ---------------------------------------------------------------------------
// validateSupabaseUrl: config.js の supabaseUrl の形式検証
// ---------------------------------------------------------------------------

Deno.test("validateSupabaseUrl: 素のプロジェクトURLは通る", () => {
  assertEquals(validateSupabaseUrl("https://x.supabase.co"), "https://x.supabase.co");
});

Deno.test("validateSupabaseUrl: /rest/v1/ 付きは弾かれる", () => {
  assertThrows(() => validateSupabaseUrl("https://x.supabase.co/rest/v1/"));
});

Deno.test("validateSupabaseUrl: /rest/v1（末尾スラッシュ無し）も弾かれる", () => {
  assertThrows(() => validateSupabaseUrl("https://x.supabase.co/rest/v1"));
});

Deno.test("validateSupabaseUrl: /auth/v1 や /functions/v1 も弾かれる", () => {
  assertThrows(() => validateSupabaseUrl("https://x.supabase.co/auth/v1"));
  assertThrows(() => validateSupabaseUrl("https://x.supabase.co/functions/v1"));
});

Deno.test("validateSupabaseUrl: 末尾スラッシュのみは弾かれずに正規化される", () => {
  assertEquals(validateSupabaseUrl("https://x.supabase.co/"), "https://x.supabase.co");
});

Deno.test("validateSupabaseUrl: 空文字/未設定は弾かれる", () => {
  assertThrows(() => validateSupabaseUrl(""));
  assertThrows(() => validateSupabaseUrl(undefined as unknown as string));
});

Deno.test("validateSupabaseUrl: 正規化後にfunctions/v1を連結しても二重スラッシュにならない", () => {
  const normalized = validateSupabaseUrl("https://x.supabase.co/");
  const functionsBase = `${normalized}/functions/v1`;
  assertEquals(functionsBase, "https://x.supabase.co/functions/v1");
  assert(!functionsBase.includes("//functions"));
});

// ---------------------------------------------------------------------------
// buildRedirectTo: Google/マジックリンク共通のredirectTo組み立て
// ---------------------------------------------------------------------------

Deno.test("buildRedirectTo: config.jsのappUrlがそのまま使われる（ハードコードではない）", () => {
  const url = "https://66088kobayashi-ship-it.github.io/gemini/frontend/";
  assertEquals(
    buildRedirectTo(url),
    "https://66088kobayashi-ship-it.github.io/gemini/frontend",
  );
});

Deno.test("buildRedirectTo: 末尾スラッシュを正規化し、連結しても二重スラッシュにならない", () => {
  const normalized = buildRedirectTo("https://example.github.io/app/");
  assertEquals(normalized, "https://example.github.io/app");
  const concatenated = `${normalized}/callback`;
  assert(!concatenated.includes("//callback"));
});

Deno.test("buildRedirectTo: 空/未設定は例外になる", () => {
  assertThrows(() => buildRedirectTo(""));
  assertThrows(() => buildRedirectTo(undefined as unknown as string));
});

// ---------------------------------------------------------------------------
// OAuth エラー: マジックリンクとは別の文言にマップされる
// ---------------------------------------------------------------------------

Deno.test("extractOAuthErrorText: ハッシュフラグメントからerror/descriptionを取り出す", () => {
  const text = extractOAuthErrorText("", "#error=access_denied&error_description=User%20denied");
  assertEquals(text, "access_denied: User denied");
});

Deno.test("extractOAuthErrorText: クエリ文字列からも取り出せる", () => {
  const text = extractOAuthErrorText("?error=server_error", "");
  assertEquals(text, "server_error");
});

Deno.test("extractOAuthErrorText: エラーが無ければnull", () => {
  assertEquals(extractOAuthErrorText("", ""), null);
  assertEquals(extractOAuthErrorText("?foo=bar", "#baz=qux"), null);
});

Deno.test("mapOAuthError: キャンセルは専用の文言になる", () => {
  const msg = mapOAuthError("access_denied: User denied access");
  assert(msg.includes("キャンセル"));
});

Deno.test("mapOAuthError: プロバイダ未設定は専用の文言になる", () => {
  const msg = mapOAuthError("Unsupported provider: provider is not enabled");
  assert(msg.includes("有効になっていない"));
});

Deno.test("mapOAuthError: リダイレクト不一致は専用の文言になる", () => {
  const msg = mapOAuthError("redirect_uri_mismatch");
  assert(msg.includes("リダイレクト"));
});

Deno.test("mapOAuthError: マジックリンクのエラー文言とは別の文言になる", () => {
  const cases = [
    "access_denied",
    "Unsupported provider: provider is not enabled",
    "redirect_uri_mismatch",
    "unknown_error",
    "",
  ];
  for (const c of cases) {
    assertNotEquals(mapOAuthError(c), MAGIC_LINK_ERROR_TEXT);
  }
});

// ---------------------------------------------------------------------------
// buildRunBody: before/after を常に含める
// ---------------------------------------------------------------------------

Deno.test("buildRunBody: before/after が空でも配列として含まれる", () => {
  const plan = { before: [], loop: [{ role: "propose", model: "m1" }], after: [], rounds: 3 };
  const body = buildRunBody(plan, "条件", "指示");
  assertEquals(Array.isArray(body.plan.before), true);
  assertEquals(Array.isArray(body.plan.after), true);
  assertEquals(body.plan.before, []);
  assertEquals(body.plan.after, []);
});

Deno.test("buildRunBody: before/after未指定でも配列として含まれる（省略しない）", () => {
  const plan = { loop: [{ role: "propose", model: "m1" }], rounds: 1 };
  const body = buildRunBody(plan, "条件", "指示");
  assert("before" in body.plan);
  assert("after" in body.plan);
  assertEquals(body.plan.before, []);
  assertEquals(body.plan.after, []);
});

Deno.test("buildRunBody: loopはrole/modelだけを送る", () => {
  const plan = {
    before: [],
    loop: [{ role: "propose", model: "openrouter/free-a", extraneous: "捨てられるべき" }],
    after: [],
    rounds: 2,
  };
  const body = buildRunBody(plan, "条件", "指示");
  assertEquals(body.plan.loop, [{ role: "propose", model: "openrouter/free-a" }]);
  assertEquals(body.plan.criteria, "条件");
  assertEquals(body.plan.rounds, 2);
});

Deno.test("buildRunBody: instructionが必ず含まれ、criteriaと結合されない", () => {
  const plan = { before: [], loop: [{ role: "propose", model: "m1" }], after: [], rounds: 1 };
  const body = buildRunBody(plan, "800字以内でまとめる", "新製品の告知文を書いてほしい");
  assert("instruction" in body.plan);
  assertEquals(body.plan.instruction, "新製品の告知文を書いてほしい");
  assertEquals(body.plan.criteria, "800字以内でまとめる");
  // 結合されていれば片方の文字列にもう片方が混ざる。混ざっていないことを確認する
  assert(!body.plan.criteria.includes("告知文"));
  assert(!body.plan.instruction.includes("800字"));
});

Deno.test("buildRunBody: instructionが空/未指定だと即座に例外になる（渡し忘れを検出する）", () => {
  const plan = { before: [], loop: [{ role: "propose", model: "m1" }], after: [], rounds: 1 };
  assertThrows(() => buildRunBody(plan, "条件", ""));
  assertThrows(() => buildRunBody(plan, "条件", undefined));
});

// ---------------------------------------------------------------------------
// composeRunRequest: index.html の start() が呼ぶ唯一の入口
// ---------------------------------------------------------------------------

const ROLES_FIXTURE = {
  propose: { model: "openrouter/free-a" },
  critic: { model: "openrouter/free-b" },
};

Deno.test("composeRunRequest: 指示欄のテキスト(promptText)がinstructionとして届く", () => {
  const body = composeRunRequest({
    loopNodes: [{ kind: "propose" }, { kind: "critic" }],
    roles: ROLES_FIXTURE,
    rounds: 3,
    criteriaText: "800字以内でまとめる",
    promptText: "新製品の告知文を書いてほしい",
  });
  assertEquals(body.plan.instruction, "新製品の告知文を書いてほしい");
  assertEquals(body.plan.criteria, "800字以内でまとめる");
  assertEquals(body.plan.loop, [
    { role: "propose", model: "openrouter/free-a" },
    { role: "critic", model: "openrouter/free-b" },
  ]);
});

Deno.test("composeRunRequest: 【これがいま起きていたバグそのもの】promptTextを使わずに組み立てると検出できる", () => {
  // 実際に起きていた不具合は「吹き出し表示にだけ text を使い、/run には渡さない」
  // というものだった。ここではそれを composeRunRequest の呼び出し側で再現する:
  // promptText を渡さず、表示用の text 相当を別の変数に閉じ込めて捨てる。
  const displayOnlyText = "新製品の告知文を書いてほしい"; // 吹き出し表示にしか使わない、というバグを模す
  assertThrows(
    () =>
      composeRunRequest({
        loopNodes: [{ kind: "propose" }, { kind: "critic" }],
        roles: ROLES_FIXTURE,
        rounds: 3,
        criteriaText: "800字以内でまとめる",
        promptText: undefined as unknown as string, // displayOnlyText を渡し忘れている状態
      }),
    "instructionを渡し忘れても例外にならず、モデルに届かないまま実行できてしまっている",
  );
  void displayOnlyText;
});

// ---------------------------------------------------------------------------
// canSubmit
// ---------------------------------------------------------------------------

Deno.test("canSubmit: loopが2未満なら送信不可", () => {
  const r = canSubmit({ loopLength: 1, criteria: "x", callsNeeded: 3, quotaRemaining: 10 });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "loop_too_short");
});

Deno.test("canSubmit: criteriaが空なら送信不可", () => {
  const r = canSubmit({ loopLength: 3, criteria: "   ", callsNeeded: 3, quotaRemaining: 10 });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "empty_criteria");
});

Deno.test("canSubmit: 残量不足なら送信不可", () => {
  const r = canSubmit({ loopLength: 3, criteria: "x", callsNeeded: 20, quotaRemaining: 10 });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "quota");
});

Deno.test("canSubmit: 条件を満たせば送信可", () => {
  const r = canSubmit({ loopLength: 3, criteria: "x", callsNeeded: 9, quotaRemaining: 10 });
  assertEquals(r.ok, true);
});

// ---------------------------------------------------------------------------
// エラー文言: 401/403/400/409/402/207 がそれぞれ別の文言
// ---------------------------------------------------------------------------

Deno.test("エラー文言: 401/403/400/409/402/429/207 はすべて異なる文言になる", () => {
  const messages = new Set<string>();
  messages.add(mapErrorMessage(401, {}));
  messages.add(mapErrorMessage(403, {}));
  messages.add(mapErrorMessage(400, {}));
  messages.add(mapErrorMessage(409, { needed: 9, remaining: 3 }));
  messages.add(mapErrorMessage(402, {}));
  messages.add(mapErrorMessage(429, {}));
  const partial = interpretRunResponse(207, {
    transcript: [],
    verdict: null,
    callsActual: 1,
    callsPlanned: 1,
    warning: "記録に失敗した",
  });
  assert(partial.kind === "partial");
  if (partial.kind === "partial") messages.add(partial.warning);
  assertEquals(messages.size, 7, `重複がある: ${JSON.stringify([...messages])}`);
});

Deno.test("エラー文言: 429は「混雑・再試行」の趣旨で、402/404/401とは別の文言になる", () => {
  const rateLimited = mapErrorMessage(429, {});
  assert(rateLimited.includes("混") || rateLimited.includes("待"));
  assertNotEquals(rateLimited, mapErrorMessage(402, {}));
  assertNotEquals(rateLimited, mapErrorMessage(401, {}));
  assertNotEquals(rateLimited, mapErrorMessage(404, {}));
});

Deno.test("エラー文言: 409は残り回数と不足回数を含む（既存文言と同じ形）", () => {
  const msg = mapErrorMessage(409, { needed: 9, remaining: 3 });
  assert(msg.includes("9"));
  assert(msg.includes("3"));
  assert(msg.includes("6")); // 9-3
});

Deno.test("エラー文言: 401はログインへ戻すフラグが立つ", () => {
  const r = interpretRunResponse(401, { error: "unauthorized" });
  assert(r.kind === "error");
  if (r.kind === "error") {
    assertEquals(r.redirectToLogin, true);
  }
});

Deno.test("エラー文言: 403/400/409/402はログインへ戻さない", () => {
  for (const status of [403, 400, 409, 402]) {
    const r = interpretRunResponse(status, {});
    assert(r.kind === "error");
    if (r.kind === "error") {
      assertEquals(r.redirectToLogin, false);
    }
  }
});

// ---------------------------------------------------------------------------
// 207: 結果を表示しつつ記録失敗も表示する
// ---------------------------------------------------------------------------

Deno.test("207: transcriptとwarningの両方を返す（記録失敗を握りつぶさない）", () => {
  const body = {
    transcript: [{ participantId: "loop:0", role: "propose", label: "提案", text: "初稿" }],
    verdict: "PASS",
    callsActual: 3,
    callsPlanned: 6,
    warning: "使用量の記録に失敗した",
  };
  const r = interpretRunResponse(207, body);
  assertEquals(r.kind, "partial");
  if (r.kind === "partial") {
    assertEquals(r.transcript.length, 1);
    assertEquals(r.warning, "使用量の記録に失敗した");
  }
});

Deno.test("207は200と同じkindにならない", () => {
  const bodyOk = { transcript: [], verdict: null, callsActual: 1, callsPlanned: 1 };
  const r200 = interpretRunResponse(200, bodyOk);
  const r207 = interpretRunResponse(207, { ...bodyOk, warning: "記録失敗" });
  assertEquals(r200.kind, "success");
  assertEquals(r207.kind, "partial");
  assert(r200.kind !== r207.kind);
});

// ---------------------------------------------------------------------------
// display と model の分離
// ---------------------------------------------------------------------------

Deno.test("applyModelConfig: 上書きが無ければdefaultsのmodel/displayを使う", () => {
  const defaults = { propose: { model: "free/a", display: "モデルA(無料)" } };
  const merged = applyModelConfig(defaults, undefined);
  assertEquals(merged.propose, { model: "free/a", display: "モデルA(無料)" });
});

Deno.test("applyModelConfig: 上書きはmodel/displayを両方ペアで差し替える", () => {
  const defaults = { propose: { model: "free/a", display: "モデルA(無料)" } };
  const overrides = { propose: { model: "paid/b", display: "モデルB(有料)" } };
  const merged = applyModelConfig(defaults, overrides);
  assertEquals(merged.propose.model, "paid/b");
  assertEquals(merged.propose.display, "モデルB(有料)");
});

Deno.test("applyModelConfig: modelだけ変えてdisplayを書き忘れても、古いdisplayが残らない", () => {
  const defaults = { propose: { model: "free/a", display: "モデルA(無料)" } };
  // display を書き忘れた上書き設定
  const overrides = { propose: { model: "paid/b" } };
  const merged = applyModelConfig(defaults, overrides);
  assertEquals(merged.propose.model, "paid/b");
  assert(
    merged.propose.display !== defaults.propose.display,
    "modelを変えたのにdisplayが古いdefaultのまま残っている",
  );
});

Deno.test("applyModelConfig: 無料モデルが消えたときのconfig.js上書きシナリオ", () => {
  // 実際にあった状況を模す: 既定モデルがOpenRouterから無くなったので、
  // index.htmlを触らずconfig.jsのmodelsだけで差し替える。
  const defaults = {
    propose: { model: "meta-llama/llama-3.3-70b-instruct:free", display: "Llama 3.3 70B Instruct（無料枠）" },
  };
  const overrides = {
    propose: { model: "nvidia/nemotron-3-ultra-550b-a55b:free", display: "Nemotron 3 Ultra" },
  };
  const merged = applyModelConfig(defaults, overrides);
  assertEquals(merged.propose.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
  assertEquals(merged.propose.display, "Nemotron 3 Ultra");
  assert(merged.propose.display !== defaults.propose.display);
  assert(!merged.propose.display.includes("Llama"), "消えたモデルの表示名が残っている");
});

// ---------------------------------------------------------------------------
// groupByLap
// ---------------------------------------------------------------------------

Deno.test("groupByLap: loop長ごとに周回を区切る", () => {
  const transcript = Array.from({ length: 6 }, (_, i) => ({ text: `t${i}` }));
  const laps = groupByLap(transcript, 2);
  assertEquals(laps.length, 3);
  assertEquals(laps[0].length, 2);
});

// ---------------------------------------------------------------------------
// stripBossEntry: instructionの二重表示・周回ずれの防止
// ---------------------------------------------------------------------------

Deno.test("stripBossEntry: role:bossの要素を取り除く", () => {
  const transcript = [
    { participantId: "boss", role: "boss", label: "指示", text: "書いて" },
    { participantId: "loop:0", role: "propose", label: "提案", text: "初稿" },
    { participantId: "loop:1", role: "critic", label: "批判", text: "指摘" },
  ];
  const stripped = stripBossEntry(transcript);
  assertEquals(stripped.length, 2);
  assertEquals(stripped.every((e) => e.role !== "boss"), true);
});

Deno.test("stripBossEntry後にgroupByLapすると周回がずれない", () => {
  const transcript = [
    { participantId: "boss", role: "boss", label: "指示", text: "書いて" },
    { participantId: "loop:0", role: "propose", label: "提案", text: "r1-propose" },
    { participantId: "loop:1", role: "critic", label: "批判", text: "r1-critic" },
    { participantId: "loop:0", role: "propose", label: "提案", text: "r2-propose" },
    { participantId: "loop:1", role: "critic", label: "批判", text: "r2-critic" },
  ];
  const laps = groupByLap(stripBossEntry(transcript), 2);
  assertEquals(laps.length, 2);
  assertEquals(laps[0].map((e) => e.role), ["propose", "critic"]);
  assertEquals(laps[1].map((e) => e.role), ["propose", "critic"]);
});
