// 実行計画の型・視点変換・巡回・消費計算。すべて純粋関数（HTTP/DBに触れない）。
// Deno / ブラウザどちらからも import できるよう、標準構文のみ使用する。

export interface PlanStep {
  role: string; // 役ID（"propose" / "critic" / "check" など）
  model: string; // provider/model 形式の OpenRouter モデルID
}

export interface Plan {
  before: PlanStep[];
  loop: PlanStep[];
  after: PlanStep[];
  rounds: number;
  criteria: string; // 「どうなったら終わりか」。毎ターンの system prompt に入る
  instruction: string; // 「何をしてほしいか」。transcript の先頭に一度だけ入る
}

export interface TranscriptEntry {
  participantId: string; // 例: "loop:0"。役が重複しても一意
  role: string; // その参加者の役ID（"propose" 等）
  label: string; // 表示名（他人の発言に前置される）
  text: string;
}

export interface AdapterMessage {
  role: "assistant" | "user";
  content: string;
}

export const CHECK_ROLE = "check";
export const PASS_MARK = "PASS";
export const FAIL_MARK = "FAIL";

// instruction を transcript の先頭に置くときの発言者。loop/before/after の
// 参加者ID("loop:0" 等)とは絶対に衝突しない固定文字列。
export const BOSS_PARTICIPANT_ID = "boss";
export const BOSS_ROLE = "boss";
export const BOSS_LABEL = "指示";

export const ROLE_LABELS: Record<string, string> = {
  propose: "提案",
  critic: "批判",
  check: "検収",
  research: "調査",
  digest: "要約",
};

export function labelFor(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/** 消費回数 = before + loop*rounds + after。クライアント申告値は使わず、
 * サーバー側は常にこの関数で再計算する。 */
export function callsPlanned(plan: Plan): number {
  return plan.before.length + plan.loop.length * plan.rounds + plan.after.length;
}

interface FlatStep {
  participantId: string;
  role: string;
  model: string;
  round: number | null; // before/after は null
}

/** 3区間 × 周回を、実行順どおりの一直線の配列に展開する。分岐はない。 */
export function flattenSteps(plan: Plan): FlatStep[] {
  const steps: FlatStep[] = [];
  plan.before.forEach((s, i) => {
    steps.push({ participantId: `before:${i}`, role: s.role, model: s.model, round: null });
  });
  for (let r = 0; r < plan.rounds; r++) {
    plan.loop.forEach((s, i) => {
      steps.push({ participantId: `loop:${i}`, role: s.role, model: s.model, round: r });
    });
  }
  plan.after.forEach((s, i) => {
    steps.push({ participantId: `after:${i}`, role: s.role, model: s.model, round: null });
  });
  return steps;
}

function totalParticipants(plan: Plan): number {
  return plan.before.length + plan.loop.length + plan.after.length;
}

/** 条件と役割を毎ターンの system prompt に明記する。文脈窓を切り詰めても
 * 失われないようにするため。検収役は判定のみに強く縛る。 */
export function buildSystemPrompt(plan: Plan, role: string): string {
  const lines = [
    `あなたは「${labelFor(role)}」役としてAIの輪に参加しています。`,
    `条件: ${plan.criteria}`,
  ];
  if (role === CHECK_ROLE) {
    lines.push(
      `あなたの出力は判定のみです。以下の形式を厳守してください。`,
      `条件をすべて満たしていれば、行頭に "${PASS_MARK}" とだけ書く。`,
      `満たしていなければ、行頭に "${FAIL_MARK}" と書き、続けて未達の項目とその理由のみを書く。`,
      `改善案・代替案・提案は絶対に書かない。`,
    );
  }
  return lines.join("\n");
}

/** 中立な transcript を、呼ぶ側（participantId）の視点に変換する。
 * 自分の発言→assistant、他人の発言→user。3人以上のときは他人の発言の
 * 本文先頭に発言者名を付ける。窓を切った結果、先頭が自分の発言になる場合は
 * その要素を捨てる（配列の先頭は必ず他人の発言でなければならない）。
 * 指示（boss）の発言は、人数に関わらず常に発言者名を付ける
 * （付けないと、2人の輪では「指示」と「相手の発言」の区別がつかない）。 */
export function buildMessages(
  transcript: TranscriptEntry[],
  participantId: string,
  plan: Plan,
  window: number,
): AdapterMessage[] {
  const windowed = window > 0 ? transcript.slice(-window) : transcript.slice();

  let start = 0;
  while (start < windowed.length && windowed[start].participantId === participantId) {
    start++;
  }
  const trimmed = windowed.slice(start);

  const multiParty = totalParticipants(plan) >= 3;

  return trimmed.map((entry) => {
    if (entry.participantId === participantId) {
      return { role: "assistant", content: entry.text };
    }
    const shouldLabel = multiParty || entry.participantId === BOSS_PARTICIPANT_ID;
    const content = shouldLabel ? `[${entry.label}] ${entry.text}` : entry.text;
    return { role: "user", content };
  });
}

export interface CallModelArgs {
  systemPrompt: string;
  messages: AdapterMessage[];
  model: string;
}

export type CallModelFn = (args: CallModelArgs) => Promise<string>;

export interface RunResult {
  transcript: TranscriptEntry[];
  callsPlanned: number;
  callsActual: number;
  verdict: "PASS" | "FAIL" | null;
}

export interface RunPlanOptions {
  callModel: CallModelFn;
  window?: number;
  onEntry?: (entry: TranscriptEntry) => void;
  /** 周回上限に達した実行を「続きから」再開するときに、前回の transcript を
   * そのまま引き継ぐ。指定した場合、instruction の再挿入は行わない
   * （すでに priorTranscript の先頭に含まれているはずのため、二重に
   * 積むと会話が壊れる）。省略時は既存どおりの挙動（空から始まり、
   * instruction を先頭に一度だけ積む）で、既存の呼び出し元には一切
   * 影響しない。 */
  priorTranscript?: TranscriptEntry[];
}

/** 計画を最初から最後まで実行する。分岐はなく、常に一直線。
 * 検収役が PASS を返した時点で、残りの区間があっても即座に打ち切る。 */
export async function runPlan(plan: Plan, opts: RunPlanOptions): Promise<RunResult> {
  const window = opts.window ?? 12;
  const steps = flattenSteps(plan);
  const transcript: TranscriptEntry[] = opts.priorTranscript ? [...opts.priorTranscript] : [];
  let verdict: "PASS" | "FAIL" | null = null;
  let callsActual = 0;

  // instruction はボスの発言として transcript の先頭に一度だけ入れる。
  // 全員から見て「他人の発言」（role: "user"）になる。API 呼び出しは発生しない
  // ので callsActual には数えない。
  // priorTranscript が渡された場合（再開）は、そこに既に instruction が
  // 含まれているはずなので、ここでは追加しない。
  if (!opts.priorTranscript && plan.instruction && plan.instruction.trim().length > 0) {
    transcript.push({
      participantId: BOSS_PARTICIPANT_ID,
      role: BOSS_ROLE,
      label: BOSS_LABEL,
      text: plan.instruction,
    });
  }

  for (const step of steps) {
    const systemPrompt = buildSystemPrompt(plan, step.role);
    const messages = buildMessages(transcript, step.participantId, plan, window);
    const text = await opts.callModel({ systemPrompt, messages, model: step.model });

    const entry: TranscriptEntry = {
      participantId: step.participantId,
      role: step.role,
      label: labelFor(step.role),
      text,
    };
    transcript.push(entry);
    callsActual++;
    opts.onEntry?.(entry);

    if (step.role === CHECK_ROLE) {
      const trimmed = text.trim();
      if (trimmed.startsWith(PASS_MARK)) {
        verdict = "PASS";
        break;
      }
      if (trimmed.startsWith(FAIL_MARK)) {
        verdict = "FAIL";
      }
    }
  }

  return {
    transcript,
    callsPlanned: callsPlanned(plan),
    callsActual,
    verdict,
  };
}

/** UTC の日付境界。JST の0時では絶対にリセットされない。 */
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export interface ValidationError {
  status: number;
  message: string;
}

/** /run のバリデーション。criteria / instruction が空なら 400。 */
export function validatePlan(plan: Plan): ValidationError | null {
  if (!plan.criteria || plan.criteria.trim().length === 0) {
    return { status: 400, message: "criteria must not be empty" };
  }
  if (!plan.instruction || plan.instruction.trim().length === 0) {
    return { status: 400, message: "instruction must not be empty" };
  }
  if (!Array.isArray(plan.loop) || plan.loop.length === 0) {
    return { status: 400, message: "loop must have at least one step" };
  }
  if (!Number.isInteger(plan.rounds) || plan.rounds < 1) {
    return { status: 400, message: "rounds must be a positive integer" };
  }
  return null;
}

export interface QuotaCheck {
  ok: boolean;
  remaining: number;
}

/** 呼び出し前の残量チェック。calls > remaining なら実行を始めない。 */
export function checkQuota(usedToday: number, limit: number, callsNeeded: number): QuotaCheck {
  const remaining = limit - usedToday;
  return { ok: callsNeeded <= remaining, remaining };
}

export type ExecuteRunResult =
  | { kind: "invalid"; status: number; message: string }
  | { kind: "quota_exceeded"; status: 409; remaining: number; needed: number }
  | { kind: "ok"; result: RunResult };

/** /run のロジック本体（HTTP/認証/DBを含まない）。
 * JWT検証・allowlist照合はこれを呼び出す側（Edge Function）の責務。
 * 順序は必ず: 1) criteria検証 2) 消費回数の再計算 3) 残量チェック 4) 実行。
 * 逆順にすると1回分超過するため、この関数の外でも順序を変えないこと。
 *
 * priorTranscript を渡すと「続きから」実行になる。この場合 plan は
 * before/after を空にし、loop と rounds だけを「追加ぶん」として渡すこと
 * （呼び出し側の責務）。callsPlanned(plan) はその追加ぶんだけを返すので、
 * 消費回数の再計算式自体は一切変えていない。 */
export async function executeRun(
  plan: Plan,
  usedToday: number,
  dailyLimit: number,
  callModel: CallModelFn,
  window = 12,
  priorTranscript?: TranscriptEntry[],
): Promise<ExecuteRunResult> {
  const invalid = validatePlan(plan);
  if (invalid) {
    return { kind: "invalid", status: invalid.status, message: invalid.message };
  }

  const needed = callsPlanned(plan);
  const quota = checkQuota(usedToday, dailyLimit, needed);
  if (!quota.ok) {
    return { kind: "quota_exceeded", status: 409, remaining: quota.remaining, needed };
  }

  const result = await runPlan(plan, { callModel, window, priorTranscript });
  return { kind: "ok", result };
}

/** 周回上限に達して終わった実行かどうか（＝再開できるかどうか）。
 * PASS で終わった実行は条件を満たして終わっているので再開できない。
 * FAIL（検収が最後まで通らなかった）も null（検収役が無い等、判定が
 * 出ないまま周回を使い切った）も、いずれも「周回上限に達した」に含まれ、
 * 再開できる。表示上の終了理由の区別は endReasonOf が行う。 */
export function isResumable(verdict: "PASS" | "FAIL" | null): boolean {
  return verdict !== PASS_MARK;
}

export type EndReason = "pass" | "limit_reached" | "failed";

/** 履歴一覧・詳細に表示する終了理由。
 * PASS: 条件を満たして終了。 failed: 検収が最後までFAILのまま周回を
 * 使い切った。limit_reached: 検収役が無い等、判定が出ないまま周回を
 * 使い切った。failed/limit_reached はどちらも isResumable() = true。 */
export function endReasonOf(verdict: "PASS" | "FAIL" | null): EndReason {
  if (verdict === PASS_MARK) return "pass";
  if (verdict === FAIL_MARK) return "failed";
  return "limit_reached";
}
