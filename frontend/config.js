// 結 の実行時設定。値を書き換えるだけでよく、index.html / logic.js には
// 触れなくていい。Supabase の Project Settings > API から取得する。
//
// supabaseAnonKey は「anon / public」キー（公開して問題ない）。
// service_role キーは絶対にここに書かないこと（Edge Function の Secret にのみ置く）。
window.YUI_CONFIG = {
  supabaseUrl: "https://rkhljqhrlvcmbhhmykvq.supabase.co",
  supabaseAnonKey: "sb_publishable_NqWIHzQsgEk31Uq_X6LaCA_e83jUbCP",

  // マジックリンク・Google OAuth 共通の戻り先URL。GitHub Pages の公開URL
  // （末尾スラッシュは自動で正規化される）。未設定でも今アクセスしている
  // URLにフォールバックするが、Google OAuthはSupabase側のRedirect URLsと
  // 完全一致している必要があるため、明示しておくのが安全。
  appUrl: "https://66088kobayashi-ship-it.github.io/gemini/frontend/",

  // 無料枠の間の既定モデル。役の色・アイコンは役（propose/critic/...）に
  // 紐付いているので、ここを差し替えても輪の見た目は壊れない。
  // 上書きする場合、model と display は必ず同時に書き換えること
  // （display を書き忘れると undefined になり、その場で気づける）。
  //
  // index.html の DEFAULT_MODEL_CONFIG が既定値だが、無料モデルの一覧は
  // 入れ替わる（2026-09-05 時点で既定の2モデルが実際に無くなっていたことを
  // 確認済み）。index.html を書き換えなくても、ここで上書きすれば
  // 差し替えられる。次に消えたときはまずここを直す。
  // 実在するIDは https://openrouter.ai/models で都度確認すること。
  models: {
    // propose: { model: "openrouter/xxx:free", display: "実際のモデル名（無料枠）" },
  },
};
