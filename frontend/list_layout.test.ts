// .log（flex-direction:column）の子として並ぶ .pin は、行数が多く .log の
// 表示領域を超えたとき、デフォルトの flex-shrink:1 のままだと flexbox が
// 各行を自然な高さより縮めてしまう。履歴一覧を2段構成（題名+メタ情報）に
// した際、元々1行時代のタップ領域確保のためだけに付けていた min-height が、
// 縮小後の「実質的な上限」として働き、メタ情報が枠からはみ出すレイアウト
// 崩れになった（実機で発見。Playwrightでの実測でも再現・修正を確認済み）。
//
// ここでは実行はせず、index.html をテキストとして読み、「.pin に
// flex-shrink:0 が指定されているか」を機械的に確認する。これは、実際に
// Playwrightで検証済みの修正が、将来の編集で書き戻し忘れ等によって
// 失われていないかを検出するための最小限のテキストチェックであり、
// CSSの実際のレンダリング結果（本当に縮小されないこと自体）までは
// 保証しない。特に、min-height の絶対値が実際のコンテンツの自然な高さを
// 上回っていないか（＝将来また同じ罠を踏んでいないか）は、ブラウザでの
// レイアウト計算が必要なため、このテキスト照合では検出できない
// （README「既知の限界」参照）。
import { assert } from "../supabase/functions/_shared/test_util.ts";

const HTML_PATH = new URL("./index.html", import.meta.url);

Deno.test("list_layout: .pin にflex-shrink:0が指定されている（縦スクロール一覧の圧縮防止）", async () => {
  const html = await Deno.readTextFile(HTML_PATH);
  const pinRuleMatch = /\.pin\{[^}]*\}/.exec(html);
  assert(pinRuleMatch !== null, ".pin のCSSルールが index.html に見つからない");
  assert(
    pinRuleMatch![0].includes("flex-shrink:0"),
    `.pin に flex-shrink:0 が無い（.log内で行数が多いとき圧縮される可能性がある）: ${pinRuleMatch![0]}`,
  );
});
