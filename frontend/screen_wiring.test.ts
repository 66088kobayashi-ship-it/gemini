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
