// フロントの「配線」ロジックのうち、DOM に触れない純粋な部分だけを切り出す。
// ブラウザからは <script type="module"> で読み込み、テストは deno test で
// このファイルを直接 import する（同じファイルを両方から使う）。

const KNOWN_SUPABASE_SUBPATHS = ["/rest/v1", "/auth/v1", "/functions/v1", "/storage/v1", "/realtime/v1"];

/** 末尾スラッシュを取り除くだけの共通正規化。空文字/未設定は例外にする。
 * validateSupabaseUrl と buildRedirectTo の両方がこれを使うことで、
 * どちらも `${url}/xxx` の形で連結したときに二重スラッシュを作らない。 */
function normalizeUrl(url, label) {
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new Error(`${label} が設定されていません`);
  }
  return url.replace(/\/+$/, "");
}

/**
 * config.js の supabaseUrl を検証・正規化する。
 *
 * supabase-js は createClient() に渡した URL に対して内部で /rest/v1 や
 * /auth/v1 を自分で付け足す。Edge Function の呼び出し先も
 * `${supabaseUrl}/functions/v1` として組み立てる。そのため supabaseUrl 自体に
 * サブパスが付いていると、実際のリクエストが `/rest/v1/rest/v1/...` や
 * `.../rest/v1//functions/v1` のような壊れたURLになる。
 *
 * このミスは実際に一度起きた（Project Settings の表示からコピーする際に
 * `/rest/v1/` まで含めてしまった）。無言で誤ったURLを組み立てず、
 * 起動時に気づけるよう即座に例外にする。
 *
 * 末尾スラッシュは実害が無い（削れば済む）ので、弾かずに正規化するだけに
 * とどめる。ここで削らずに通すと `${url}/functions/v1` が
 * `.../supabase.co//functions/v1` のように二重スラッシュになってしまう。
 *
 * @param {string} url
 * @returns {string} 末尾スラッシュを除いた正規化済みURL
 */
export function validateSupabaseUrl(url) {
  const normalized = normalizeUrl(url, "config.js の supabaseUrl");
  const lower = normalized.toLowerCase();
  for (const sub of KNOWN_SUPABASE_SUBPATHS) {
    if (lower.endsWith(sub)) {
      throw new Error(
        `config.js の supabaseUrl にサブパス "${sub}" が含まれています。` +
          `Project Settings → API の「Project URL」に表示される、` +
          `サブパスの付かない素のURL（例: https://xxxxx.supabase.co）を入れてください。` +
          `渡された値: ${url}`,
      );
    }
  }
  return normalized;
}

/**
 * マジックリンク／Google OAuth 共通の redirectTo を組み立てる。
 * config.js の appUrl（またはフォールバック値）を渡す。ハードコードしない。
 * validateSupabaseUrl と同じ正規化（末尾スラッシュ除去）を使うことで、
 * 呼び出し側が将来これに何かを連結しても二重スラッシュにならない。
 * @param {string} appUrl
 * @returns {string}
 */
export function buildRedirectTo(appUrl) {
  return normalizeUrl(appUrl, "アプリのURL");
}

/**
 * Supabase Auth の OAuth リダイレクト先に付与されるエラー情報を取り出す。
 * 失敗時、Supabase はクエリ文字列またはハッシュフラグメントに
 * error / error_description を付けてリダイレクトしてくる。
 * @param {string} search location.search（例: "?error=access_denied"）
 * @param {string} hash location.hash（例: "#error=server_error&error_description=..."）
 * @returns {string | null} "error: description" 形式の生テキスト。無ければ null
 */
export function extractOAuthErrorText(search, hash) {
  const hashParams = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const searchParams = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const error = hashParams.get("error") || searchParams.get("error");
  if (!error) return null;
  const description = hashParams.get("error_description") || searchParams.get("error_description") || "";
  return description ? `${error}: ${description}` : error;
}

/**
 * OAuthのエラー（signInWithOAuth() 自体の error.message、または
 * extractOAuthErrorText() が返した文字列）を画面文言に変換する。
 * マジックリンクのエラー文言（"送信できなかった。もう一度試す"）とは
 * 別の文言にする。原因が別（Google側の問題）であることが分かるように。
 * @param {string} rawMessage
 * @returns {string}
 */
export function mapOAuthError(rawMessage) {
  const text = String(rawMessage || "").toLowerCase();
  if (!text) return "Googleログインに失敗した";
  if (text.includes("access_denied") || text.includes("cancel")) {
    return "Googleログインがキャンセルされた";
  }
  if (text.includes("redirect")) {
    return "リダイレクト先の設定が正しくない（Supabase側のRedirect URLsを確認してほしい）";
  }
  if (text.includes("provider") || text.includes("not enabled") || text.includes("unsupported")) {
    return "Googleログインが有効になっていない";
  }
  return `Googleログインに失敗した（${rawMessage}）`;
}

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

/** 周回上限に達して終わった実行かどうか（＝再開できるかどうか）。
 * サーバー側（engine.ts の isResumable）と同じ判定をフロント表示用に
 * 複製したもの。PASSで終わった実行は条件を満たして終わっているので
 * 再開できない。実際に再開できるかどうかは必ずサーバー側で再判定される
 * （ここでの判定は「続きから」ボタンを出す/出さないの表示制御にすぎず、
 * 信用の根拠ではない）。
 * @param {"PASS"|"FAIL"|null} verdict
 * @returns {boolean}
 */
export function isResumable(verdict) {
  return verdict !== "PASS";
}

/** 履歴一覧・詳細に表示する終了理由の文言。3つとも異なる文言にする。
 * @param {"PASS"|"FAIL"|null} verdict
 * @returns {string}
 */
export function endReasonLabel(verdict) {
  if (verdict === "PASS") return "PASS";
  if (verdict === "FAIL") return "失敗";
  return "上限到達";
}

/** POST /run の「続きから」リクエストボディを組み立てる。
 * 消費回数そのものは一切含めない（サーバー側が addedRounds と輪の人数から
 * 再計算する）。runId/addedRounds を渡し忘れると即座に例外にする
 * （instructionの渡し忘れバグと同じ理由: 黙って壊れた状態で送信しない）。
 * @param {string} runId
 * @param {number} addedRounds
 */
export function buildResumeRequest(runId, addedRounds) {
  if (!runId || String(runId).trim().length === 0) {
    throw new Error("buildResumeRequest: runId is required");
  }
  if (!Number.isInteger(addedRounds) || addedRounds < 1) {
    throw new Error("buildResumeRequest: addedRounds must be a positive integer");
  }
  return { resume: { runId, addedRounds } };
}

/** 再開時の消費回数 = 追加する周回数 × 輪の人数。表示と実際のリクエストの
 * 両方がこの1つの式だけを使うことで、画面表示と実際の呼び出し回数が
 * ずれることを構造的に防ぐ。
 * @param {number} loopLength
 * @param {number} addedRounds
 */
export function resumeCallsNeeded(loopLength, addedRounds) {
  return loopLength * addedRounds;
}

/** 再開ボタンを押せるかどうかの判定。既存の canSubmit と同じ形にした
 * 専用の判定関数（criteriaの再入力は無いので条件が異なるため分けている）。
 * ここでの判定はUI制御にすぎず、実際の可否は必ずサーバー側で再判定される。
 * @param {{resumable: boolean, callsNeeded: number, quotaRemaining: number}} args
 */
export function canResume({ resumable, callsNeeded, quotaRemaining }) {
  if (!resumable) {
    return { ok: false, reason: "not_resumable" };
  }
  if (callsNeeded > quotaRemaining) {
    return { ok: false, reason: "quota" };
  }
  return { ok: true, reason: null };
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
    case 429:
      return "いま混んでいる。少し待って再試行してほしい";
    case 502:
      return "このモデルが応答を返さなかった。別のモデルを試してほしい";
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

// ---------------------------------------------------------------------------
// 画面遷移（gate/loom/room/history/detail）の対応表
//
// 実際に一度、履歴詳細(detail)画面ぶんの「#loomを隠すCSSルール」を書き忘れ、
// #loomのトレイ・条件欄・開始ボタンが履歴詳細画面に透けて表示される
// レイアウト崩れが起きた。これは、このプロジェクトで3回目の
// 「純粋関数はテスト済みだが、それを使う配線が未テスト」という失敗の形
// （1: instructionがモデルに渡っていなかった、2: OPENROUTER_API_KEYの
// チェックが認証より前にあった、3: 今回）。
//
// CSSの実際の描画そのものはdeno testでは検証できない（ブラウザが無いため）。
// ここでできるのは、「画面名の集合」と「各画面でどのviewを隠すべきか」を
// 唯一の正典（single source of truth）として書き出し、それ自体の整合性
// （未知の画面名を検出できるか、画面を1つ追加し忘れたら気づけるか）を
// テストすること。加えて、frontend/screen_wiring.test.ts で、この対応表と
// index.html の実際のCSS文字列との整合（#loomを隠すルールが全画面ぶん
// 揃っているか）を機械的に突き合わせる。
// ---------------------------------------------------------------------------

/** アプリが持つ画面名の全て。setScreen() はこれ以外の名前を拒否する。
 * 新しい画面を追加したら、まずここに追記すること。 */
export const SCREEN_NAMES = ["gate", "loom", "room", "history", "detail"];

/** #loom だけ、他の画面（gate/room/history/detail）と違って既定で可視の
 * 「ホーム画面」であり、既定で非表示のベースCSSルールを持たない
 * （他の画面は `#room{opacity:0;...}` のように、既定非表示のCSSがあり、
 * 自分がアクティブなときだけ明示的に可視にする、という安全な作りになって
 * いる）。そのため #loom だけは、自分以外の画面がアクティブなときに
 * 明示的に隠すCSSルールが画面ごとに必要で、新しい画面を追加するたびに
 * 書き忘れるリスクがある（実際に一度起きた）。 */
export const DEFAULT_VISIBLE_VIEW = "loom";

/**
 * screen を表示しているとき、可視であってはいけない view id の一覧を返す
 * （= SCREEN_NAMES から screen 自身を除いた残り全部。「ちょうど1画面だけが
 * 可視であるべき」という不変条件をそのまま表す）。
 * 未知の画面名を渡すと例外を投げる（画面を追加したのに SCREEN_NAMES への
 * 追記を忘れた場合や、呼び出し側のタイプミスをその場で検出するため）。
 * @param {string} screen
 * @returns {string[]}
 */
export function viewsThatMustBeHidden(screen) {
  if (!SCREEN_NAMES.includes(screen)) {
    throw new Error(`viewsThatMustBeHidden: unknown screen "${screen}"`);
  }
  return SCREEN_NAMES.filter((v) => v !== screen);
}

// ---------------------------------------------------------------------------
// メッセージ本文の最小限のMarkdown整形
//
// モデルの出力はMarkdown記法混じりの生テキストで返ってくるため、そのまま
// 表示すると `**` や `##` が画面にそのまま出て読みにくい。外部のMarkdown
// パーサは追加せず、太字(**)・見出し(#〜######)・箇条書き(-/*)・改行の保持
// の4つだけを自前で最小限変換する。それ以外の記法（リンク・テーブル・
// コードブロック等）は特別扱いせず、記号ごとそのままエスケープして表示する
// （記号を消さない、壊れた表示にしない）。
//
// セキュリティ上の必須要件: モデルの出力は信用できない文字列である。
// renderMessageMarkdown() が返すHTML文字列に、入力テキストの中身が
// タグとして混入することは無い。抽出した各テキスト片は必ず escapeHtml() を
// 経由してからタグで囲んでいるため（この関数自身が組み立てる
// <p>/<h1>〜<h6>/<ul>/<li>/<strong>/<br> 以外のタグが出力に現れることはない）。
// ---------------------------------------------------------------------------

/** HTML特殊文字をエスケープする。 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/** 1行ぶんのテキストを **太字** の境界で分割する。閉じていない ** は
 * リテラルな文字としてそのまま扱う（壊れた表示にしない）。
 * @param {string} line
 * @returns {Array<{text: string, bold: boolean}>}
 */
function parseInlineRuns(line) {
  const runs = [];
  const re = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > lastIndex) {
      runs.push({ text: line.slice(lastIndex, m.index), bold: false });
    }
    runs.push({ text: m[1], bold: true });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < line.length || runs.length === 0) {
    runs.push({ text: line.slice(lastIndex), bold: false });
  }
  return runs;
}

/** runsを、必ずescapeHtml()を経由させてからHTML文字列に変換する。
 * ここが安全性の要（生のテキストがそのままタグとして混入する経路が無い）。 */
function runsToHtml(runs) {
  return runs.map((r) => {
    const escaped = escapeHtml(r.text);
    return r.bold ? `<strong>${escaped}</strong>` : escaped;
  }).join("");
}

/**
 * モデルの出力テキストを、最小限のMarkdownとして解釈した安全なHTML文字列に
 * 変換する。対応するのは太字(**)・見出し(#〜######)・箇条書き(-/*)・
 * 改行の保持のみ。それ以外の記法は記号ごとそのままエスケープして表示する。
 *
 * 返り値は innerHTML にそのまま代入してよい（escapeHtml() を必ず経由して
 * いるため、入力テキストの中身がタグとして解釈されることは無い）。
 * @param {string} text
 * @returns {string}
 */
export function renderMessageMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const htmlParts = [];
  let paragraphLines = [];
  let listItems = [];

  function flushParagraph() {
    if (paragraphLines.length === 0) return;
    const html = paragraphLines.map((l) => runsToHtml(parseInlineRuns(l))).join("<br>");
    htmlParts.push(`<p>${html}</p>`);
    paragraphLines = [];
  }
  function flushList() {
    if (listItems.length === 0) return;
    const html = listItems.map((l) => `<li>${runsToHtml(parseInlineRuns(l))}</li>`).join("");
    htmlParts.push(`<ul>${html}</ul>`);
    listItems = [];
  }

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    const bulletMatch = /^[-*]\s+(.*)$/.exec(line);

    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      htmlParts.push(`<h${level}>${runsToHtml(parseInlineRuns(headingMatch[2]))}</h${level}>`);
    } else if (bulletMatch) {
      flushParagraph();
      listItems.push(bulletMatch[1]);
    } else if (line.trim().length === 0) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraphLines.push(line);
    }
  }
  flushParagraph();
  flushList();

  return htmlParts.join("");
}
