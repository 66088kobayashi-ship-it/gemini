// 結 の実行時設定。値を書き換えるだけでよく、index.html / logic.js には
// 触れなくていい。Supabase の Project Settings > API から取得する。
//
// supabaseAnonKey は「anon / public」キー（公開して問題ない）。
// service_role キーは絶対にここに書かないこと（Edge Function の Secret にのみ置く）。
window.YUI_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT-REF.supabase.co",
  supabaseAnonKey: "YOUR-ANON-KEY",

  // 無料枠の間の既定モデル。役の色・アイコンは役（propose/critic/...）に
  // 紐付いているので、ここを差し替えても輪の見た目は壊れない。
  // 上書きする場合、model と display は必ず同時に書き換えること
  // （display を書き忘れると undefined になり、その場で気づける）。
  // OpenRouter の無料モデルの一覧・実在するIDは https://openrouter.ai/models で
  // 都度確認すること（掲載モデルは入れ替わる）。
  models: {
    // propose: { model: "openrouter/xxx:free", display: "実際のモデル名（無料枠）" },
  },
};
