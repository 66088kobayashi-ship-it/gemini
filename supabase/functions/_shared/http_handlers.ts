// /quota と /run のHTTPロジック本体。Deno.serve や supabase-js には触れない
// （それは index.ts の責務）。ここは依存をすべて引数で受け取るので、
// 実サーバーを立てずに deno test だけで検証できる。

import { CallModelFn, executeRun, isResumable, Plan, PlanStep, RunResult, TranscriptEntry, utcDay } from "./engine.ts";

export interface AuthContext {
  userId: string;
  email: string;
}

/** Authorization ヘッダの JWT を検証する。失敗時は null を返す
 * （ヘッダ欠落・不正フォーマット・トークン無効のいずれも含む）。 */
export type VerifyJwtFn = (authHeader: string | null) => Promise<AuthContext | null>;

export type IsAllowlistedFn = (email: string) => Promise<boolean>;

export type GetUsedTodayFn = (userId: string, day: string) => Promise<number>;

export interface PersistRunInput {
  userId: string;
  day: string;
  callsActual: number;
  callsPlanned: number;
  plan: Plan;
  transcript: RunResult["transcript"];
  verdict: "PASS" | "FAIL" | null;
}

export interface PersistRunOutput {
  ok: boolean;
  runId?: string;
  error?: string;
}

/** usage への加算と runs への記録。実装（supabase_adapters.ts）は
 * これを1回のアトミックな呼び出し（record_run RPC）にすること。
 * read-then-write に分解しないこと。 */
export type PersistRunFn = (input: PersistRunInput) => Promise<PersistRunOutput>;

/** 「続きから」再開するときに読み出す、保存済みの実行1件分。
 * plan は元の実行の plan をそのまま（criteria/instruction/loop を
 * 再開後も使い回すため）、transcript は再開の起点として引き継ぐ。 */
export interface StoredRun {
  plan: Plan;
  transcript: TranscriptEntry[];
  verdict: "PASS" | "FAIL" | null;
}

/** userId と runId の両方が一致する行だけを返す。他人の実行IDを渡された
 * 場合も、存在しない場合も、区別せず null を返すこと（実装側の責務）。
 * 呼び出し元はどちらも 404 として扱う（実行IDの存在を外部に漏らさない）。 */
export type GetRunByIdFn = (userId: string, runId: string) => Promise<StoredRun | null>;

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GET /quota
// ---------------------------------------------------------------------------

export interface HandleQuotaDeps {
  verifyJwt: VerifyJwtFn;
  getUsedToday: GetUsedTodayFn;
  dailyLimit: number;
  now?: () => Date;
}

export async function handleQuota(
  authHeader: string | null,
  deps: HandleQuotaDeps,
): Promise<HttpResult> {
  const auth = await deps.verifyJwt(authHeader);
  if (!auth) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  const day = utcDay(deps.now?.() ?? new Date());
  const used = await deps.getUsedToday(auth.userId, day);
  return {
    status: 200,
    body: { used, limit: deps.dailyLimit, remaining: deps.dailyLimit - used },
  };
}

// ---------------------------------------------------------------------------
// POST /run
// ---------------------------------------------------------------------------

export interface HandleRunDeps {
  verifyJwt: VerifyJwtFn;
  isAllowlisted: IsAllowlistedFn;
  getUsedToday: GetUsedTodayFn;
  persistRun: PersistRunFn;
  getRunById: GetRunByIdFn;
  callModel: CallModelFn;
  dailyLimit: number;
  window?: number;
  now?: () => Date;
}

function coerceSteps(raw: unknown): PlanStep[] | null {
  if (!Array.isArray(raw)) return null;
  const steps: PlanStep[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const it = item as Record<string, unknown>;
    if (typeof it.role !== "string" || typeof it.model !== "string") return null;
    steps.push({ role: it.role, model: it.model });
  }
  return steps;
}

/** リクエストボディから Plan だけを取り出す。クライアントが "calls" のような
 * 消費回数の申告値を含めていても、それはここで一切読まない
 * （executeRun が常に callsPlanned() で再計算する）。 */
function coercePlan(rawBody: unknown): Plan | null {
  if (typeof rawBody !== "object" || rawBody === null) return null;
  const body = rawBody as Record<string, unknown>;
  const rawPlan = body.plan;
  if (typeof rawPlan !== "object" || rawPlan === null) return null;
  const p = rawPlan as Record<string, unknown>;

  const before = coerceSteps(p.before);
  const loop = coerceSteps(p.loop);
  const after = coerceSteps(p.after);
  if (!before || !loop || !after) return null;

  if (typeof p.rounds !== "number" || !Number.isInteger(p.rounds)) return null;
  if (typeof p.criteria !== "string") return null;
  if (typeof p.instruction !== "string") return null;

  return { before, loop, after, rounds: p.rounds, criteria: p.criteria, instruction: p.instruction };
}

type RunRequest =
  | { kind: "fresh"; plan: Plan }
  | { kind: "resume"; runId: string; addedRounds: number };

/** リクエストボディが「新規実行」(`plan`) と「再開」(`resume`) の
 * どちらかを判定する。両方/どちらも無い場合は不正な入力として null を返す。
 * 再開側も、クライアントが消費回数そのものを申告する余地は一切無い
 * （addedRounds という「追加する周回数」だけを受け取り、消費回数は
 * サーバー側で callsPlanned() から再計算する）。 */
function coerceRunRequest(rawBody: unknown): RunRequest | null {
  if (typeof rawBody !== "object" || rawBody === null) return null;
  const body = rawBody as Record<string, unknown>;
  const hasPlan = body.plan !== undefined && body.plan !== null;
  const hasResume = body.resume !== undefined && body.resume !== null;
  if (hasPlan === hasResume) return null; // 両方 or どちらも無いのは不正

  if (hasResume) {
    if (typeof body.resume !== "object") return null;
    const r = body.resume as Record<string, unknown>;
    if (typeof r.runId !== "string" || r.runId.trim().length === 0) return null;
    if (typeof r.addedRounds !== "number" || !Number.isInteger(r.addedRounds) || r.addedRounds < 1) {
      return null;
    }
    return { kind: "resume", runId: r.runId, addedRounds: r.addedRounds };
  }

  const plan = coercePlan(rawBody);
  if (!plan) return null;
  return { kind: "fresh", plan };
}

export async function handleRun(
  authHeader: string | null,
  rawBody: unknown,
  deps: HandleRunDeps,
): Promise<HttpResult> {
  const auth = await deps.verifyJwt(authHeader);
  if (!auth) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  const allowed = await deps.isAllowlisted(auth.email);
  if (!allowed) {
    return { status: 403, body: { error: "not allowlisted" } };
  }

  const parsed = coerceRunRequest(rawBody);
  if (!parsed) {
    return { status: 400, body: { error: "invalid plan" } };
  }

  let plan: Plan;
  let priorTranscript: TranscriptEntry[] | undefined;

  if (parsed.kind === "resume") {
    // 他人の実行ID・存在しない実行IDは区別せず404にする（実行IDの存在自体を
    // 外部に漏らさないため）。
    const original = await deps.getRunById(auth.userId, parsed.runId);
    if (!original) {
      return { status: 404, body: { error: "run not found" } };
    }
    // PASSで終わった実行は条件を満たして終わっているので再開できない。
    // クライアント側のボタン非表示に頼らず、ここで必ず弾く。
    if (!isResumable(original.verdict)) {
      return { status: 400, body: { error: "この実行はPASSで終了しているため、再開できません" } };
    }
    plan = {
      before: [],
      loop: original.plan.loop,
      after: [],
      rounds: parsed.addedRounds,
      criteria: original.plan.criteria,
      instruction: original.plan.instruction,
    };
    priorTranscript = original.transcript;
  } else {
    plan = parsed.plan;
  }

  const day = utcDay(deps.now?.() ?? new Date());
  const usedToday = await deps.getUsedToday(auth.userId, day);

  const outcome = await executeRun(
    plan,
    usedToday,
    deps.dailyLimit,
    deps.callModel,
    deps.window ?? 12,
    priorTranscript,
  );

  if (outcome.kind === "invalid") {
    return { status: outcome.status, body: { error: outcome.message } };
  }
  if (outcome.kind === "quota_exceeded") {
    return {
      status: 409,
      body: { error: "quota exceeded", needed: outcome.needed, remaining: outcome.remaining },
    };
  }

  // outcome.kind === "ok" 。ここから先、実際の呼び出しはもう発生しない。
  // 加算するのは outcome.result.callsActual（実際に呼んだ回数）であって、
  // 計画値 callsPlanned ではない。
  const persisted = await deps.persistRun({
    userId: auth.userId,
    day,
    callsActual: outcome.result.callsActual,
    callsPlanned: outcome.result.callsPlanned,
    plan,
    transcript: outcome.result.transcript,
    verdict: outcome.result.verdict,
  });

  if (!persisted.ok) {
    // 実行自体は成功している（＝実際に課金は発生している）ので、
    // 黙って200成功として返さない。207で「記録に失敗した」ことを
    // 明示し、ログにも残す。
    console.error("usage/runs の記録に失敗しました:", persisted.error);
    return {
      status: 207,
      body: {
        transcript: outcome.result.transcript,
        verdict: outcome.result.verdict,
        callsActual: outcome.result.callsActual,
        callsPlanned: outcome.result.callsPlanned,
        warning: "実行は完了しましたが、使用量の記録に失敗しました。運営に連絡してください。",
      },
    };
  }

  return {
    status: 200,
    body: {
      runId: persisted.runId,
      transcript: outcome.result.transcript,
      verdict: outcome.result.verdict,
      callsActual: outcome.result.callsActual,
      callsPlanned: outcome.result.callsPlanned,
    },
  };
}
