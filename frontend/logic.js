// フロントの「配線」ロジックのうち、DOM に触れない純粋な部分だけを切り出す。
// ブラウザからは <script type="module"> で読み込み、テストは deno test で
// このファイルを直接 import する（同じファイルを両方から使う）。

/** POST /run のボディを組み立てる。plan.before / plan.after が未指定でも
 * 常に配列として含める（省略すると calls の再計算が噛み合わなくなる）。
 * criteria（どうなったら終わりか）と instruction（何をしてほしいか）は
 * 結合せず、別フィールドのまま送る。
 * instruction を渡し忘れる／空のまま呼ぶと、サーバーに届く前にここで
 * 気づけるよう即座に例外にする（渡し忘れても200のまま黙って動いてしまう、
 * という壊れ方を防ぐため）。 */
export function buildRunBody(plan, criteria, instruction) {
  if (!instruction || String(instruction).trim().length === 0) {
    throw new Error("buildRunBody: instruction is required");
  }
  return {
    plan: {
      before: (plan.before ?? []).map((s) => ({ role: s.role, model: s.model })),
      loop: (plan.loop ?? []).map((s) => ({ role: s.role, model: s.model })),
      after: (plan.after ?? []).map((s) => ({ role: s.role, model: s.model })),
      rounds: plan.rounds,
      criteria,
      instruction,
    },
  };
}

/**
 * 画面の現在状態から /run のリクエストボディを組み立てる、唯一の入口。
 * index.html の start() はこれだけを呼ぶ（buildRunBody を直接呼ばない）。
 *
 * 名前付き引数にしているのは、「指示欄に打った文字列 (promptText) を
 * instruction として渡し忘れる」という不具合が実際に一度起きたため。
 * 位置引数だと省略しても構文エラーにならず気づけないが、これなら
 * promptText を渡し忘れれば buildRunBody が即座に例外を投げる。
 *
 * @param {{
 *   before?: Array<{role: string, model: string}>,
 *   loopNodes: Array<{kind: string}>,
 *   roles: Record<string, {model: string}>,
 *   after?: Array<{role: string, model: string}>,
 *   rounds: number,
 *   criteriaText: string,
 *   promptText: string,
 * }} args
 */
export function composeRunRequest({
  before = [],
  loopNodes,
  roles,
  after = [],
  rounds,
  criteriaText,
  promptText,
}) {
  const loop = loopNodes.map((n) => ({ role: n.kind, model: roles[n.kind].model }));
  return buildRunBody({ before, loop, after, rounds }, criteriaText, promptText);
}

/** 送信可能かどうかの判定。既存 UI の refresh() が持っていた条件をそのまま
 * 純粋関数として切り出したもの。 */
export function canSubmit({ loopLength, criteria, callsNeeded, quotaRemaining }) {
  if (loopLength < 2) {
    return { ok: false, reason: "loop_too_short" };
  }
  if (!criteria || criteria.trim().length === 0) {
    return { ok: false, reason: "empty_criteria" };
  }
  if (callsNeeded > quotaRemaining) {
    return { ok: false, reason: "quota" };
  }
  return { ok: true, reason: null };
}

/** ステータスコード -> 表示文言。すべて別の文言にする
 * （何が起きて次にどうすればいいかが区別できること）。 */
export function mapErrorMessage(status, body) {
  switch (status) {
    case 401:
      return "セッションの期限が切れた。もう一度ログインしてほしい";
    case 403:
      return "このアカウントはまだ許可されていない";
    case 400:
      return "満たすべき条件を書くと、開始できる";
    case 409: {
      const needed = typeof body?.needed === "number" ? body.needed : null;
      const remaining = typeof body?.remaining === "number" ? body.remaining : null;
      if (needed !== null && remaining !== null) {
        return `この輪は${needed}回ぶん。残り${remaining}回では${needed - remaining}回足りない`;
      }
      return "残量が足りない";
    }
    case 402:
      return "OpenRouterの残高が尽きた";
    case 0:
      return "つながらなかった。もう一度試す";
    default:
      return `通信に失敗した（status=${status}）`;
  }
}

/** /run のレスポンスを解釈する。200/207/エラーで扱いを分ける。
 * 207 を 200 と同じ分岐に入れないこと（記録失敗を握りつぶさないため）。 */
export function interpretRunResponse(status, body) {
  if (status === 200) {
    return {
      kind: "success",
      transcript: body.transcript,
      verdict: body.verdict,
      callsActual: body.callsActual,
      callsPlanned: body.callsPlanned,
    };
  }
  if (status === 207) {
    return {
      kind: "partial",
      transcript: body.transcript,
      verdict: body.verdict,
      callsActual: body.callsActual,
      callsPlanned: body.callsPlanned,
      warning: body.warning ?? "実行は完了したが、記録に失敗した",
    };
  }
  return {
    kind: "error",
    status,
    message: mapErrorMessage(status, body),
    redirectToLogin: status === 401,
  };
}

/** 役ごとの { model, display } を組み立てる。config が role を上書きする場合、
 * model と display は必ずペアで丸ごと差し替える（フィールド単位でマージしない）。
 * こうすることで「model だけ変えて display が古いまま残る」が構造的に起きない
 * （display を書き忘れると undefined になり、その場で気づける）。 */
/**
 * @param {Record<string, {model: string, display: string}>} defaults
 * @param {Record<string, {model?: string, display?: string}>} [overrides]
 * @returns {Record<string, {model: string, display: string}>}
 */
export function applyModelConfig(defaults, overrides) {
  /** @type {Record<string, {model: string, display: string}>} */
  const merged = {};
  for (const key of Object.keys(defaults)) {
    const hasOverride = overrides && Object.prototype.hasOwnProperty.call(overrides, key);
    merged[key] = hasOverride
      ? { model: overrides[key].model, display: overrides[key].display }
      : { model: defaults[key].model, display: defaults[key].display };
  }
  return merged;
}

/**
 * transcript を周回ごとにグループ分けする。before/after が空である前提
 * （v1）で、loop の長さで単純に割る。
 * @template T
 * @param {T[]} transcript
 * @param {number} loopLength
 * @returns {T[][]}
 */
export function groupByLap(transcript, loopLength) {
  if (loopLength <= 0) return [transcript];
  const laps = [];
  for (let i = 0; i < transcript.length; i += loopLength) {
    laps.push(transcript.slice(i, i + loopLength));
  }
  return laps;
}

const BOSS_ROLE = "boss";

/** /run が返す transcript から instruction（ボスの発言）を取り除く。
 * フロントは指示テキストを送信直後に自分のバブルとして既に表示しているため、
 * ここで取り除かないと groupByLap の周回対応がずれる（ボスの1件ぶん先頭に
 * 混ざり、以降のグルーピングが loopLength ぶんずれ続ける）うえ、
 * 二重表示にもなる。 */
/**
 * @param {Array<{role: string}>} transcript
 * @returns {Array<{role: string}>}
 */
export function stripBossEntry(transcript) {
  return transcript.filter((e) => e.role !== BOSS_ROLE);
}
