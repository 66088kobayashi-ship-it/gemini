// index.html のインラインスクリプト・CSSの「実行」そのものはブラウザでしか
// 検証できず、自動テストの対象外（README「既知の限界」参照）。
//
// ただしここでは実行はせず、index.html を単なるテキストとして読み、
// logic.js の SCREEN_NAMES / viewsThatMustBeHidden が要求する
// 「#loomを画面ごとに隠すCSSルール」が文字列として存在するかどうかだけを
// 正規表現で機械的に確認する。これは静的なテキスト照合であり、
// ブラウザがそのCSSを実際にどう適用するか（見た目・スタッキング）までは
// 保証しない（README参照）。
//
// 実際に一度、履歴詳細(detail)画面ぶんのこのルールを書き忘れ、#loomの
// トレイ・条件欄・開始ボタンが履歴詳細画面に透けて表示されるレイアウト
// 崩れが起きた。このテストはその再発を検出するためのもの。
import { assert } from "../supabase/functions/_shared/test_util.ts";
import { DEFAULT_VISIBLE_VIEW, SCREEN_NAMES, viewsThatMustBeHidden } from "./logic.js";

const HTML_PATH = new URL("./index.html", import.meta.url);

Deno.test("screen_wiring: index.htmlに、#loomを隠す必要がある全画面ぶんのCSSルールが存在する", async () => {
  const html = await Deno.readTextFile(HTML_PATH);

  // SCREEN_NAMES のうち、DEFAULT_VISIBLE_VIEW(loom) 自身を除いた
  // すべての画面が対象（loom画面のときはloom自身を隠す必要が無い）。
  const screensNeedingLoomHidden = SCREEN_NAMES.filter((screen) =>
    viewsThatMustBeHidden(screen).includes(DEFAULT_VISIBLE_VIEW)
  );
  assert(screensNeedingLoomHidden.length === SCREEN_NAMES.length - 1);

  for (const screen of screensNeedingLoomHidden) {
    const pattern = new RegExp(
      `body\\[data-screen="${screen}"\\]\\s*#${DEFAULT_VISIBLE_VIEW}\\{[^}]*opacity:0[^}]*pointer-events:none[^}]*\\}`,
    );
    assert(
      pattern.test(html),
      `index.htmlに body[data-screen="${screen}"] #${DEFAULT_VISIBLE_VIEW}{...opacity:0...pointer-events:none...} ` +
        `という形のCSSルールが見つからない（実際に一度、detail画面ぶんのこのルールを書き忘れて` +
        `レイアウトが崩れたことがある）`,
    );
  }
});

// ---------------------------------------------------------------------------
// 会話室(#room)と履歴詳細(#detail)は、transcript描画に同じ関数
// (renderTranscriptInto、内部でrenderMessageMarkdownを使う)を使うことで、
// 表示（Markdown整形・エスケープ処理）が食い違わないようにしている。
// ここでも実行はせず、index.htmlのテキストに対して「実装が1つしかないか」
// 「両画面から同じ関数が呼ばれているか」を機械的に確認する。
// もし将来、片方の画面専用に処理をコピーして分岐させた場合、この関数の
// 定義が複数になるか、呼び出し箇所数が減るかのどちらかになるはずなので、
// それを検出できる。ただし、同じ関数名を保ったまま中身だけ画面ごとに
// 分岐させるような書き方をされた場合はこのテキスト照合では検出できない
// （README「既知の限界」参照）。
// ---------------------------------------------------------------------------

Deno.test("screen_wiring: 会話室と履歴詳細のtranscript描画がrenderTranscriptInto1つに統一されている", async () => {
  const html = await Deno.readTextFile(HTML_PATH);

  const definitionCount = (html.match(/function renderTranscriptInto\(/g) || []).length;
  assert(definitionCount === 1, `renderTranscriptIntoの定義が${definitionCount}個ある（実装が分岐した可能性）`);

  // renderTranscript()内(#room用) + openDetail()内(#detail用) +
  // resumeBtn.onclick内(#detail用、続きから実行後の再描画) の
  // 最低3箇所から呼ばれているはず。
  const callSites = html.match(/renderTranscriptInto\(/g) || [];
  assert(
    callSites.length >= 3,
    `renderTranscriptIntoの呼び出し箇所が想定より少ない（${callSites.length}件）。` +
      `#roomと#detailが別々の描画処理に分岐していないか確認すること`,
  );
});
