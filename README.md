# 結 — AIをつなぐ

AIエージェントを輪にして往復させるWebアプリ。フロントは静的HTML/JS
（GitHub Pages）、認証・実行・使用量管理は Supabase（Auth + Postgres +
Edge Functions）、推論は OpenRouter（OpenAI互換の単一エンドポイント）。

## 構成

```
frontend/
  index.html                       # UI本体（元 ui-prototype-v5.html）。
                                    # CSS/HTML構造は変更していない
  logic.js                         # フロントの純粋ロジック（DOM非依存）
  logic.test.ts                    # ↑のテスト
  screen_wiring.test.ts            # index.htmlをテキストとして読み、画面
                                    # 遷移CSSの対応漏れを機械的に検出する
                                    # （実行はしない。既知の限界は本文参照）
  config.js                        # Supabase URL/anonキー・モデル設定
                                    # （書き換えるだけでよい）

supabase/
  migrations/0001_init.sql         # allowlist / usage / runs + RLS + record_run()
  functions/
    _shared/
      engine.ts                    # 視点変換・巡回・消費計算（純粋関数）
      engine.test.ts
      http_handlers.ts             # /quota, /run のロジック本体（依存注入）
      http_handlers.test.ts
      openrouter.ts                # OpenRouterアダプタ（リトライ/402処理）
      openrouter.test.ts
      supabase_adapters.ts         # 上記を実SupabaseClientにつなぐ
                                    # （再開用のmakeGetRunByIdを含む）
      supabase_adapters.test.ts
      cors.ts
      test_util.ts                 # 自前の最小アサーション（外部依存なし）
    quota/
      index.ts                     # Deno.serve を呼ぶだけの薄いラッパー
      handler.ts                   # GET /quota の実体（依存注入でテスト可能）
      handler.test.ts
    run/
      index.ts                     # Deno.serve を呼ぶだけの薄いラッパー
      handler.ts                   # POST /run の実体（依存注入でテスト可能）
      handler.test.ts
```

依存は Supabase クライアント（`@supabase/supabase-js`）以外に一切追加していない。

## 既知の挙動（バグではない）

### 周回数が多いと instruction が文脈窓の外に出る

- 設計上、`instruction`（何をしてほしいか）は transcript の先頭に1度だけ入る。
  `criteria`（どうなったら終わりか）と違って、毎ターンの system prompt には
  入らない。
- そのため周回が進み、文脈窓（既定12ターン）から先頭の `instruction` が
  押し出されると、後半のターンでは各役が「何を頼まれたか」を見失う。
  条件は system prompt に残っているので「どうなったら終わりか」は分かるが、
  「何を作っているか」の手がかりが消える。
- **5周・8周で実害が出るかは未検証。実測してから対処を決める**
  （下の「実機での動作確認手順」8番）。
- 対処案（未採用）: system prompt に `instruction` を別セクションとして
  常に入れ、検収役（`check`）にだけは入れない。検収は条件との照合しか
  しないので指示の内容を知る必要がなく、むしろ `criteria` と
  `instruction` が同じ system prompt に同居すると判定基準が濁るリスクが
  ある。**実測で実害が確認できるまではこの変更を入れない。**

## 既知の限界

### `frontend/index.html` のインラインスクリプトは自動テストの対象外

`frontend/logic.js` の純粋関数（`buildRunBody` / `composeRunRequest` /
`validateSupabaseUrl` / `buildRedirectTo` / `mapOAuthError` 等）は
`deno test` で検証しているが、それを実際に呼び出す
`index.html` の `<script type="module">` 側の配線コードそのものは、
ブラウザでしか実行できないため自動テストの対象に入っていない。

この構造（純粋関数はテスト済みだが、それを呼ぶ配線は未テスト）は、
このプロジェクトで**既に3回バグを生んでいる**:

- 指示欄に打った文字列が `/run` に渡っておらず、モデルに一切届いていなかった
  （`buildRunBody` 自体は正しくテストされていたが、`index.html` 側が
  引数を渡し忘れていた）
- `OPENROUTER_API_KEY` の有無チェックが `run/index.ts` の
  `Deno.serve` コールバックの中、JWT検証・allowlist照合より前にあった
  （`handleRun` 自体は正しくテストされていたが、それを呼ぶ外側の
  エントリポイントは未テストだった）
- 履歴詳細(`detail`)画面ぶんの「`#loom` を隠すCSSルール」を書き忘れ、
  `#loom` のトレイ・条件欄・開始ボタンが履歴詳細画面に透けて表示される
  レイアウト崩れが起きた（`#room`/`#history` を隠すルールは書けていたのに、
  同じパターンを `detail` にだけ書き忘れた）

1番目・2番目は解決済み（`buildRunBody`の必須化、
`supabase/functions/run/handler.ts` への切り出し）。
**`frontend/index.html` の配線コード自体を丸ごと切り出してテストする
（`frontend/app.js` 等に分離し、DOM操作以外の呼び出し順序をテストする）
対処はまだ実施していない。** 実機確認を優先するため、ここでは将来の課題
として記録するだけにとどめる。

3番目（画面遷移のCSS書き忘れ）への対処として、`frontend/logic.js` に
`SCREEN_NAMES`/`DEFAULT_VISIBLE_VIEW`/`viewsThatMustBeHidden()` を追加した。
`SCREEN_NAMES` は画面名（`gate`/`loom`/`room`/`history`/`detail`）の唯一の
正典で、`index.html` の `setScreen()` はこれ以外の画面名を拒否する。
`viewsThatMustBeHidden(screen)` は「screenを表示しているとき隠すべき
view idの一覧」を返す純粋関数で、`logic.test.ts` でその整合性
（未知の画面名の検出、画面を1つ追加し忘れたら気づけるか）をテストしている。

**ただしこれには明確な限界がある。** `viewsThatMustBeHidden()` はあくまで
「本来こうあるべき」という対応表（スペック）であり、`index.html` の実際の
CSSがその通りに書かれているかどうかまでは、この関数自体のテストでは
検証できない。この隙間を埋めるため、`frontend/screen_wiring.test.ts` を
追加した。これは `index.html` を**実行はせず**、単なるテキストとして読み、
`body[data-screen="X"] #loom{...}` という形のCSSルールが対応表どおりに
（`viewsThatMustBeHidden()` が要求する画面ぶん）文字列として存在するかを
正規表現で機械的に確認する。**これは静的なテキスト照合であり、ブラウザが
そのCSSを実際にどう解釈・適用するか（本当に非表示になるか、スタッキングが
正しいか）までは保証しない。** 実際にこの負の対照実験でも確認した:

- `body[data-screen="detail"] #loom{...}` を削る → `screen_wiring.test.ts`
  が**検出できた**（今回のバグそのものの再現）
- `.view` の `isolation:isolate`（`.bar`/`.dock` のz-indexが兄弟画面の
  前面に飛び出すのを防ぐ構造的な保険）を削る → **どのテストも検出できな
  かった**。`isolation` はCSSの実際のスタッキング計算という、テキスト照合
  でもロジックのユニットテストでも届かない領域の性質のため。これを検出
  するには実ブラウザでのレンダリング検証（Playwright等）が必要だが、
  外部ライブラリを増やさない方針のため今は導入しない。**このプロパティを
  誤って削除・変更しても自動テストは気づけない、という限界として記録する。**

履歴一覧・詳細・再開の画面（`loadHistory()`/`openDetail()`/
`resumeBtn.onclick` 等、DOM操作そのもの）も同じ理由で自動テストの対象外。
これらが呼ぶ純粋関数（`isResumable`/`endReasonLabel`/`buildResumeRequest`/
`resumeCallsNeeded`/`canResume`/`viewsThatMustBeHidden`）自体は
`logic.test.ts` でテスト済みだが、それを呼ぶ `index.html` 側の配線
（`supabase.from('runs').select(...)` の呼び出しや、続きから実行後に
画面を更新する処理）はブラウザでしか検証できない。実機確認チェックリスト
に手順を追加して補う（下記D節）。

`#room`（会話室）と `#detail`（履歴詳細）は、transcript描画に同じ
`renderTranscriptInto()`（内部で `renderMessageMarkdown()` を使う）を
1つだけ使うことで、Markdown整形・エスケープ処理が画面ごとに食い違わない
ようにしている。これも `screen_wiring.test.ts` に、`index.html` の
テキストに対して「`renderTranscriptInto` の定義が1つだけか」「3箇所以上
（`#room`用1箇所 + `#detail`用2箇所）から呼ばれているか」を確認する
静的チェックを追加した。これは実際に負の対照実験で検証済み:
片方の画面専用に実装をコピーして分岐させる変更を加えたところ、
呼び出し箇所数の変化としてこのテストが**検出できた**
（`isolation:isolate` とは異なり、こちらはテキストレベルの構造変化として
現れるため検出可能だった）。ただし、同じ関数名を保ったまま中身だけを
画面ごとの条件分岐で変えるような書き方をされた場合は、この静的チェックでは
検出できない（そこまではブラウザでの実行検証が必要）。

### モデルIDは静的サイトなので「環境変数」ではなく `config.js` で上書きする

フロントはビルドステップを持たない静的サイトのため、サーバーサイドの
Edge Function（`DAILY_QUOTA` / `CONTEXT_WINDOW` / `OPENROUTER_API_KEY`）
のような実行時環境変数は存在しない。モデルIDを「コードを触らず差し替え
られる」ようにする実質的な等価物は `frontend/config.js` の `models`
フィールドで、これは `index.html` の `DEFAULT_MODEL_CONFIG` を
`applyModelConfig()` で上書きする形で既に機能している
（`logic.test.ts` でテスト済み）。

## セットアップ手順書

**iPad の GitHub Web UI と Supabase のダッシュボードだけで完結する。**
ローカルに clone した環境は前提にしていない
（例外が1つだけある。デプロイ前チェックリストの「同時実行の実測」は
`supabase start` を使うため、Docker が動くPCが別途必要）。

### 1. Supabase プロジェクトを作る

1. https://supabase.com でプロジェクトを作成する。
2. **SQL Editor** で `supabase/migrations/0001_init.sql` の中身を貼り付けて実行する
   （`allowlist` / `usage` / `runs` テーブルと RLS、`record_run()` 関数が作られる）。
3. **Table Editor → allowlist** で、自分のメールアドレスを1行追加する
   （`email` 列にメールアドレス、`note` は任意）。SQL Editor から
   ```sql
   insert into allowlist (email, note) values ('you@example.com', '管理者');
   ```
   でもよい。
4. **Authentication → Sign In / Providers → Email** でマジックリンク
   （Email OTP / Magic Link）が有効になっていることを確認する
   （Google OAuth はまだ実装していない）。
5. **Authentication → Emails** で、送信元メールアドレス・件名などの既定設定を
   確認する（無料プランは1時間あたりの送信数に制限があるため、実機確認で
   何度も送ると一時的に届かなくなることがある。届かない場合は少し待つ）。

### 2. Edge Function の Secrets（設定するのは後述のチェックリストのC節）

Supabase ダッシュボードの **Project Settings → Edge Functions → Secrets** で
設定する項目は以下。

| Secret 名             | 内容                                                  |
| ---------------------- | ----------------------------------------------------- |
| `OPENROUTER_API_KEY`   | OpenRouter の API キー                                |
| `DAILY_QUOTA`          | （任意）1日あたりの呼び出し上限。既定 50              |
| `CONTEXT_WINDOW`       | （任意）文脈窓の直近ターン数。既定 12                 |

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` は Supabase が自動で注入する。

（この表は **Supabase側**のEdge Function Secret。デプロイに使う
**GitHubリポジトリ側**のSecret、`SUPABASE_ACCESS_TOKEN` /
`SUPABASE_PROJECT_REF` は次の「3. Edge Functionをデプロイする」を参照。
別のダッシュボードに登録する別物なので混同しないこと。）

**`OPENROUTER_API_KEY` は今すぐ設定しない。** allowlist の防御が実機で
本当に効いていることを確認してから設定する（下のチェックリストC節、
手順9・10・11が通った後）。理由はチェックリストのA節末尾に書いてある。
`DAILY_QUOTA` / `CONTEXT_WINDOW` は課金に直結しないので、先に設定して
構わない。

キーは Edge Function の Secret にのみ置かれ、フロントのコード・ログ・
レスポンスには一切出力されない。

### 3. Edge Function をデプロイする（GitHub Actions 経由）

ローカル環境も Supabase CLI も持たない前提のため、デプロイは
`.github/workflows/deploy-functions.yml` が代行する。
`main` への push で `supabase/functions/**` に変更があったときに自動実行
されるほか、Actions タブから **workflow_dispatch で手動実行**もできる。
デプロイの前に `deno test frontend/ supabase/functions/_shared/` を実行し、
1つでも失敗したらデプロイに進まない。

このワークフローが使う Secrets は、**Supabase 側の Secrets とは別物**で、
**GitHub リポジトリの Secrets**（Settings → Secrets and variables →
Actions → New repository secret）に登録する。

| GitHub Secret 名        | 内容                                    | 取得場所                                                        |
| ------------------------ | --------------------------------------- | ----------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`  | Supabase CLI をCIから認証させるトークン | Supabase ダッシュボード → 右上のアカウントメニュー → **Access Tokens** → Generate new token |
| `SUPABASE_PROJECT_REF`   | どのSupabaseプロジェクトにデプロイするか | Supabase ダッシュボード → **Project Settings → General** → Reference ID |

このワークフローは `OPENROUTER_API_KEY` を一切設定しない。それは
Edge Function 自体の実行時Secret（Supabaseダッシュボード側）であり、
下のチェックリストC節まで待って別途設定する、別の話。

手動でデプロイしたい場合（CLIが使える環境があれば）は、代わりに:

```
supabase functions deploy quota --project-ref <あなたのプロジェクトref>
supabase functions deploy run --project-ref <あなたのプロジェクトref>
```

または Supabase ダッシュボードの **Edge Functions** 画面から直接コードを
貼り付けてデプロイすることもできる
（`supabase/functions/quota/index.ts` と `supabase/functions/run/index.ts`、
および両方が import する `_shared/` 配下一式が必要）。

### 4. フロントを設定する

`frontend/config.js` を GitHub の Web UI で直接編集する。

```js
window.YUI_CONFIG = {
  supabaseUrl: "https://xxxxxxxx.supabase.co",   // Project Settings → API → Project URL
  supabaseAnonKey: "ey...",                       // Project Settings → API → anon public
  appUrl: "https://<user>.github.io/<repo>/frontend/", // マジックリンク/Google共通の戻り先
  models: {
    // 有料に切り替えるときは model と display を必ず同時に書き換える
    // propose: { model: "anthropic/claude-sonnet-5", display: "Claude Sonnet 5" },
  },
};
```

`appUrl` は未設定でも今アクセスしているURLに自動でフォールバックするが、
Google OAuthはSupabase側の Redirect URLs と完全一致している必要があるため、
明示しておくのが安全。

**`supabaseAnonKey` には必ず「anon / public」キーを入れる。「service_role」
キーを絶対に入れないこと。** 両者の違い: `anon` キーは RLS
（Row Level Security）に守られた状態でブラウザに公開してよい鍵。
`service_role` キーは RLS を完全にバイパスする鍵で、これを取り違えて
`config.js`（＝GitHub Pagesで世界中に公開される静的ファイル）に入れると、
`allowlist` を含む全テーブルが誰でも読み書きできる状態でインターネットに
公開されることになる。

### 5. GitHub Pages を有効にする

1. リポジトリの **Settings → Pages** を開く。
2. **Source** を「Deploy from a branch」、**Branch** をデフォルトブランチ、
   **Folder** を **`/ (root)`** にする
   （GitHub Pages はブランチ配下の任意のフォルダを選べず、`/`か`/docs`しか
   選択肢がない。`frontend/` は選べないため、リポジトリ全体を公開し、
   `frontend/` 配下をサブパスとして使う）。
3. 保存すると `https://<ユーザー名>.github.io/<リポジトリ名>/frontend/`
   がアプリの公開URLになる（`frontend/index.html` がディレクトリ既定
   ページとして表示される）。
   `supabase/` 配下はソースコード（秘密鍵は一切含まない）として一緒に
   公開されるが、実害はない。

### 6. マジックリンクのリダイレクト先を設定する

Supabase ダッシュボードの **Authentication → URL Configuration** で:

- **Site URL**: `https://<ユーザー名>.github.io/<リポジトリ名>/frontend/`
- **Redirect URLs**: 同じURLを追加登録する
  （末尾のスラッシュあり・なし両方を念のため登録しておくと安全）

この設定は Google OAuth のリダイレクト先にもそのまま使われる
（`frontend/config.js` の `appUrl` を参照）。

### 7. ログイン方法（Google が主、メールが従）

Google が主、メールアドレスのマジックリンクが従の2つのログイン方法がある。
**両方とも同じJWTを発行するので、サーバー側（`handleRun`・allowlist・RLS）は
どちらでログインしたかを区別しない。**

- **Google**: Supabase ダッシュボードの **Authentication → Providers → Google**
  で Client ID / Secret を登録し有効化しておく（本READMEの対象外。
  Google Cloud Console 側でのOAuthクライアント作成を含む）。
- **マジックリンク**: Supabase 組み込みメールを使う。**プロジェクト全体で
  1時間あたり2通、かつプロジェクトのチームメンバーのアドレスにしか
  届かない**という制約がある。実機確認で詰まりやすいのはこちらなので、
  Google が使えるならそちらを優先する。allowlist に別アドレスを足す
  ときや、Googleが使えない環境向けの経路として残してある。

## デプロイ・実機確認チェックリスト

上から順に実行する。**キーを設定する前に防御を確認する** 順序になっている。
anon key は `config.js` 経由でブラウザに公開される（設計通り。防御は
`allowlist` と RLS が担っている）。したがって **`allowlist` が実際に
効いていることを確認するまで、`OPENROUTER_API_KEY` を設定しない。**
キーが未設定なら、仮に allowlist に穴があっても OpenRouter を叩けないので
課金は発生しない。防御を確認してから弾を込める、という順序にしてある。

### A. デプロイ前（キーなし）

- [ ] 1. `supabase/migrations/0001_init.sql` を適用した
- [ ] 2. `allowlist` に自分のメールアドレスを1件登録した
- [ ] 3. マジックリンクの送信元メール設定を確認した（Authentication → Emails）
- [ ] 4. `quota` / `run` の Edge Function をデプロイした（`OPENROUTER_API_KEY`
      の Secret はまだ設定しない）
- [ ] 5. `frontend/config.js` に Project URL と anon key を設定した
      （**service role key ではないことを確認した**）
- [ ] 6. GitHub Pages を有効化した（root 公開、`/frontend/` で動く）
- [ ] 7. マジックリンクのリダイレクトURL（Site URL / Redirect URLs）を登録した

### B. 防御の確認（キーなし。ここまで課金は発生しない）

- [ ] 8. ログインできるか（マジックリンクから戻ってセッションが乗るか）
- [ ] 9. **allowlist に載っていない別アドレスで 403 になるか（最重要）**
- [ ] 10. `criteria` 空で 400、API呼び出し 0 回になるか
- [ ] 11. `instruction` 空で 400、API呼び出し 0 回になるか

  上記のうち「呼び出し0回」（＝403/400の判定がOpenRouter呼び出しより前に
  来ていること）は `http_handlers.test.ts` で自動テスト済み。実機では
  キーが未設定であること自体がもう一段の防御になっている。

  **確認方法**: キーが未設定の状態で 403 / 400 が正しく返ることが、
  上記の判定順序が壊れていないことの実地証拠になる。**もし手順9で
  403 ではなく 500（キーがないエラー）が返るなら、判定順序が壊れている
  ので報告してほしい。**

  **手順9が通らないうちは、絶対に手順12・13へ進まないこと。**

### C. ここで初めてキーを込める

- [ ] 12. https://openrouter.ai/models で、既定モデルID（`frontend/index.html`
      の `DEFAULT_MODEL_CONFIG`、`:free` 付き）が現存するか確認した。
      **無料枠カタログは実際に入れ替わる**（2026-09-05、最初に置いていた
      2つの既定モデルIDが両方とも実在しなくなっていたことを確認済み）。
      現在の既定は `minimax/minimax-m3:free`（提案・調査・要約）/
      `poolside/laguna-s-2.1:free`（批判・検収）。検収は今回に限り批判と
      同じモデルを使い回している（現時点で実機応答が確認できている無料
      モデルが2つしか無いため。本来は検収を批判と別モデルにしたい）。
      これもいずれ入れ替わりうる前提でその都度確認すること。
      **`/run` が404を返したら、まずモデルIDが消えていないかを疑う。**
      無くなっていたら `index.html` を触らず、`frontend/config.js` の
      `models` で存命のモデルに上書きする（`model` と `display` は必ず
      ペアで書き換える。`display` だけ古い名前を残すと、無料モデルの
      出力を見ているのに違うモデルの名前で表示されることになる）
      **注意: カタログに存在する（＝IDが見つかる）ことと、実際に応答が
      返ってくることは別問題。** `nvidia/nemotron-3-ultra-550b-a55b:free`
      はカタログには存在していたが、実機確認（2ロール×1周）で応答が
      一切返らなかった（診断値: `finish_reason=null`,
      `messageのキー=[]`, `usage=null` — つまりOpenRouterからは
      HTTP 200が返るがmessageが空オブジェクトのまま何も入っていない
      状態）。**モデルIDの現存確認だけでは不十分で、必ず手順14の最小実行
      まで通して実際に応答が返ることを確認すること。**
      空応答（`/run` が502で「このモデルが応答を返さなかった」を返す）に
      遭遇したら、最初に疑うべきはプロンプトや実装ではなく**そのモデル
      自体が壊れている可能性**。まず該当の役だけ別の無料モデルに差し替えて
      再実行し、原因がモデル側にあるのか実装側にあるのかを切り分けること。
- [ ] 13. Edge Function の Secret に `OPENROUTER_API_KEY` を設定した

### D. 実行の確認（ここから消費が発生する）

- [ ] 14. **最小実行** — 役を2つ（無料モデル）、1周だけで実行し、実際に
      OpenRouterから応答が返ってくることを確認する
      - **吹き出しの幅**: 日本語がおおむね18〜20文字/行程度で折り返され、
        画面の右半分が大きく余っていないことを確認する（実測値。
        「25文字前後」の目安には届かないことは既知——「設計のポイント」参照）
      - **Markdown整形**: モデルの出力に `**`/`#`/`##`/`-` が含まれる場合、
        `**` や `#` が画面にそのまま出ず、太字・見出し・箇条書きとして
        読める形で表示されることを確認する
- [ ] 15. **残量の反映** — 実行後に上部の残量表示が減っていること、
      `/quota` を再取得した値と一致していることを確認する
- [ ] 16. **3人×3周** — 発言者名（`[役名]`）が各発言の前に付いていることを、
      返ってきた文面から確認する
- [ ] 17. **5周以上を1回だけ回し、後半で出力が崩れないかを目視する**
      （「既知の挙動」に書いた instruction の窓外脱落が実害を出すかどうかの
      確認。**判定基準は下の「手順17の判定基準」を参照** — 崩れたかどうかは
      実行後の印象で決めず、そこに書いた条件だけで機械的に判定する）
- [ ] 17.5. **履歴一覧・詳細・再開（実機のみで確認できる配線部分）**
      - 手順16の実行後、反物画面から「履歴」を開き、直前の実行が一覧に
        新しい順で出ること・日時/構成/周回数/終了理由/消費回数が表示
        されることを確認する
      - 一覧の行をタップし、詳細画面で保存済みの transcript が会話室と
        同じ見た目・同じ幅で表示されること、反物画面（トレイ・条件欄・
        開始ボタン）や履歴一覧のヘッダーが透けて見えたり重なったりして
        いないことを確認する（実際に一度、`#loom` を隠すCSSルールの
        書き忘れでこれが崩れたことがある。`isolation:isolate` の効果は
        自動テストで検出できないため、ここが唯一の確認手段）
      - **周回上限で終わった実行**（検収役なし、または検収がPASSしない
        まま周回を使い切った実行）を1件作り、その詳細に「続きから」の
        導線が出ることを確認する
      - **検収がPASSした実行**の詳細には「続きから」の導線が出ないことを
        確認する
      - 「続きから」で追加周回数を選び、実行前に消費回数と残量が表示
        されること、実行後に続きの発言が追記され、残量表示が正しく
        減ることを確認する

### E. 未実測として残るもの

- [ ] 18. **`supabase start` のローカルPostgresに対し、同一ユーザーで
      `/run` を同時に複数投げ、`usage.calls` が全実行ぶん正しく積算される
      ことを1度だけ確認する。** サンドボックスでは実際の同時実行を
      再現できないため、`record_run()` のアトミック性（`on conflict ...
      do update set calls = usage.calls + excluded.calls` という単一SQL文
      であること）は、現状「単一SQL文だから正しいはず」という推論に
      留まっている。本番投入前に一度だけ実測で埋めること。
      **これだけは iPad 単体では完結せず、Docker が動くPCが別途必要。**

以下は自動テストで担保済み（実機確認としてはB節の再確認で足りる）:

- [x] JWTなし/allowlist外/criteria空/instruction空/残量不足のいずれも
      `/run` が実際の呼び出しを1回もせずに拒否すること
      （`http_handlers.test.ts` で検証済み）
- [x] クライアントが偽の消費回数を送っても、サーバー側の再計算が使われること
      （検証済み）
- [x] 加算(`persistRun`)が失敗したとき、黙って200を返さないこと（検証済み）
- [x] `OPENROUTER_API_KEY` が未設定の環境でも、JWTなし/allowlist外/
      criteria空/instruction空/残量不足のいずれも、正しいステータス
      （401/403/400/400/409）で拒否され、500にならないこと
      （`run/handler.test.ts` で検証済み。エントリポイント層
      `Deno.serve` のコールバックまで含めて検証している）

## 手順17の判定基準

**実際に回す前に基準を固定しておく。** 出力を見てからの印象で
「まあ大丈夫」と判断しないため、また instruction の再掲を入れるかどうかの
決定を後付けの理由でしないため。

### 崩れていると判定する条件（1つでも該当したら「崩れた」）

- 4周目以降の発言が、指示した題材から外れている
- 検収役が、条件に書かれていない項目で PASS / FAIL を出している
- 提案役が、前の周で既に直した箇所を再び直している（指示を見失った兆候）
- 各役が「何を作っているのか」を確認する趣旨の発言を始めている

### 崩れていないと判定する条件

- 上記のいずれにも該当しない
- 4周目以降も、指示した題材について具体的に議論が続いている

### 判定の記録方法

以下を、`runs` テーブルの記録とは別に、人間が読める形でこのREADMEか
`docs/` 配下のメモに残す。

- 実行した plan（人数・周回数・`instruction`・`criteria`）
- 何周目から異変が出たか、または最後まで出なかったか
- 該当した条件があればどれか（上記の4条件のうちどれに当てはまったか）

### 崩れていた場合の対処（今は実装しない。方針の記録のみ）

- system prompt に `instruction` を**別セクション**として再掲する
- ただし**検収役には入れない**。検収は条件との照合しかしないので指示を
  知る必要がなく、入れると PASS/FAIL の判定基準が濁る
- そのとき必要になる負の対照実験: 「検収役にも instruction を入れる」に
  わざと壊し、判定が条件以外の項目に及ぶことを検出できるテストが
  赤くなることを確認する
- **この対処は手順17の結果を見てから着手する。先回りして実装しない。**

### 崩れていなかった場合

`instruction` の再掲は入れない。「既知の挙動」節に記録したまま残し、
周回数をさらに増やしたときに再検証する項目として扱う。

## ローカルでのテスト実行

```
deno test frontend/ supabase/functions/_shared/
```

テストは HTTP を一切叩かない。API呼び出し・DB・認証はすべてスタブに
差し替えて、視点変換・巡回・消費計算・HTTPロジック・エラー文言を検証する。

## 設計のポイント

- 実行計画は `before` / `loop` / `after` の3区間で保持する。v1では
  `before`/`after` は常に空配列だが、構造は減らさない
  （次の版で「一回だけ実行する役」を追加するとき、実行ロジックと
  消費計算式をそのまま伸ばせるようにするため）。
  消費回数 = `before.length + loop.length * rounds + after.length`。
- `criteria`（どうなったら終わりか）と `instruction`（何をしてほしいか）は
  別フィールドで持ち、渡す場所も分ける。`criteria` は毎ターンの system
  prompt に入れる。`instruction` は transcript の**先頭に一度だけ**、ボスの
  発言として入れ、全員が「他人の発言」として受け取る（system prompt には
  入れない）。結合すると検収役が指示文まで照合対象と誤解し、PASS/FAIL の
  基準が濁るため。どちらも空なら 400 で、API を1回も呼ばずに拒否する。
- 会話ログは中立な `transcript` として保持し、API を呼ぶ直前に呼ぶ側の
  視点（自分=assistant、他人=user）に変換する。3人以上のとき、または
  相手が指示（ボス）のときは、他人の発言の本文先頭に発言者名を付ける
  （2人の輪でも指示と相手の発言の区別がつくように）。文脈窓を切り詰めた
  結果、配列の先頭が自分の発言になる場合はその要素を捨てる
  （先頭は必ず他人の発言。窓を切ってinstructionが落ちても同様）。
- フロントの `composeRunRequest`（`frontend/logic.js`）が `/run` リクエスト
  組み立ての唯一の入口。指示欄に打った文字列を渡し忘れても、吹き出し表示
  にしか使われず実際には動かない、という不具合が実際に一度起きたため、
  `instruction` を渡さないと `buildRunBody` が即座に例外を投げる設計にした。
- 検収役（`check`）の出力は `PASS`/`FAIL` の判定のみに縛る。改善案は書か
  せない。`PASS` が出た時点で、残り周回があっても即座に打ち切る。
- `/run` の処理順は「JWT検証 → allowlist照合 → criteria/instruction検証 →
  消費回数のサーバー側再計算 → 残量チェック → 実行 → 加算・記録」。
  クライアントの申告値は一切使わない。
  **エントリポイント（`Deno.serve` のコールバック）には判定ロジックを
  置かない。置く場合は必ずテストする。認証・認可より前に分岐点を作らない。**
  （実際に一度、`run/index.ts` が `OPENROUTER_API_KEY` の有無を
  `handleRun` の呼び出しより前でチェックしており、これが
  JWT検証・allowlist照合より先に実行される「第二の入場チェック」になって
  いた。`http_handlers.test.ts` は`handleRun`を直接呼ぶため、その外側の
  `Deno.serve`コールバックを一度も検証しておらず、83本すべて緑のまま
  この穴を見逃していた。以降、`run/index.ts`・`quota/index.ts`は
  `Deno.serve`を呼ぶだけの薄いラッパーとし、判定を含む本体は同ディレクトリの
  `handler.ts`に切り出してネットワーク無しでテストする。OpenRouterの
  キーは、`handleRun`がJWT/allowlist/criteria/instruction/残量の
  すべてを通過し、実際にモデルを呼ぶ直前まで遅延評価する。）
- 使用量の加算（`usage`）と実行記録（`runs`）は、Postgresの `record_run()`
  という単一のSQL文でアトミックに行う。Edge Function 側は read-then-write
  に分解しない。加算に失敗したら黙って200を返さず、207で明示する。
- 日付境界は UTC（`usage.day`）。JSTの0時ではリセットされない。
- OpenRouterの429/5xxは指数バックオフで最大4回リトライ。402（残高不足）と、
  リトライを使い切った429（混雑）はそれぞれ専用のエラー型・HTTPステータスに
  する（429を500に丸めない。フロントには「いま混んでいる。少し待って
  再試行してほしい」と表示する）。それ以外の4xxは即座に失敗させる。
  応答の`content`が空のときは、原因を切り分けられるよう`finish_reason`・
  `message`のキー一覧・トークン数を診断情報として持たせる
  （`finish_reason==="length"`は打ち切り専用のエラーに、
  `message.reasoning`にしか本文が無い場合はその旨を区別する。
  ただし`reasoning`を`content`の代わりに使うことはしない）。
  いずれの診断情報にもAPIキーやメッセージ本文の中身は含めない。
  HTTP 200のままボディのトップレベルに`error`を含めて返してくる場合が
  あり（上流プロバイダ側の失敗を透過するケース）、`choices`の抽出より
  前に検出して専用のエラー（`UpstreamErrorResponse`）にする。また
  `choices`自体が空/欠落しているケースと、`choices[0].message`は
  存在するがその中身が空オブジェクトのケースは原因が違うため
  `choicesEmpty`フラグで区別する。これらとcontent空全般
  （`EmptyResponseError`）はまとめて502として返し、429（混雑）・
  402（残高不足）・404（モデルID誤り）とは別のステータスにする
  （フロントには「このモデルが応答を返さなかった。別のモデルを試して
  ほしい」と表示し、次の一手が分かるようにする）。
- 表示名（`display`）と実モデルID（`model`）は別フィールドで持つ。無料枠の
  間は `display` に実際のモデル名を入れ、表示が嘘にならないようにする。
  役の色・アイコンは役に紐付いているので、モデルを差し替えても図は壊れない。
- 既定モデルは無料枠（`:free`）。有料モデルを既定にはしていない。
- **履歴と再開**: `runs` は本人の行のみ RLS で読める（`runs_select_own`
  ポリシー）ので、履歴一覧・詳細は専用の Edge Function を作らず
  `frontend/index.html` から `supabase.from('runs').select(...)` で直接
  読む。書き込み（`record_run()`）と違って、読み取りは RLS だけで
  安全に担保できるため、余計な仲介コードを増やさない。
  再開できるのは**周回上限に達して終わった実行だけ**
  （`engine.ts` の `isResumable(verdict)` は `verdict !== "PASS"` で判定。
  検収が最後まで `FAIL` のままだった場合と、検収役が無い等で判定が
  出ないまま周回を使い切った場合の両方を含む）。PASSで終わった実行は
  条件を満たして終わっているので再開できない。この判定はクライアントの
  ボタン表示だけでなく、必ず `http_handlers.ts` の `handleRun` 側でも
  行う（他人の実行ID・存在しない実行IDは区別せず404、PASS済みへの
  再開要求は400）。
  再開時は `engine.ts` の `runPlan`/`executeRun` に新設した
  `priorTranscript` を渡し、前回の transcript をそのまま引き継いで
  続きの周回だけを回す。`instruction` は前回の transcript に既に
  含まれているので再挿入しない。渡す `Plan` は `before`/`after` を
  空にし、`loop` と `rounds`（追加する周回数）だけを持たせるので、
  既存の消費回数の式 `callsPlanned()` がそのまま「追加周回数×人数」を
  返す（新しい計算式を作っていない）。`buildMessages` は transcript の
  出どころを問わない汎用実装なので、再開後も「配列の先頭は必ず他人の
  発言」という不変条件は変更なしで成立する。
- **吹き出しの幅**: `.msg{max-width:78%}` に加えて、アバター(32px)+gap分の
  固定コストが日本語1文字あたりの情報密度に対して重すぎ、実機で
  「1行に12文字程度しか入らない」という問題が実際に起きた。原因は
  flexboxの計算ミスではなく、単純に確保していた幅が狭すぎたこと
  （Playwrightで `.msg`/`.bub` の実際の描画幅を測定して確認済み。
  `#room` と `#detail` は `.log`/`.msg`/`.bub` を完全に共有しているため、
  両方で同一の症状だった）。`.msg{max-width:96%}`、`.log`の左右padding
  を `var(--s2)`→`var(--s1)`、`.bub`のpaddingを`var(--s1)`に詰めることで
  対処した。実機幅375〜390pxでの実測値は、修正前12〜13文字/行 →
  修正後18〜20文字/行（アバター分の固定コストがあるため、目安とした
  「25文字前後」には届かない。アバターを画面上から外す/縮小する変更は
  デザイン変更にあたるため今回は行っていない。既存トークンの範囲内での
  実質的な上限と考えられる）。
- **メッセージのMarkdown整形**: モデルの出力は `**太字**`・`#`〜`######`
  見出し・`-`/`*` 箇条書き・改行混じりのMarkdownで返ってくるため、
  `frontend/logic.js` の `renderMessageMarkdown()` でこの4種類だけを
  最小限自前で変換する（外部のMarkdownパーサは追加しない）。対応しない
  記法（リンク・テーブル・コードブロック等）は特別扱いせず、記号ごと
  そのままエスケープして表示する。
  **セキュリティ上の必須要件として、抽出した各テキスト片は必ず
  `escapeHtml()` を経由してからタグで囲んでおり、`renderMessageMarkdown()`
  が組み立てる `<p>`/`<h1>`〜`<h6>`/`<ul>`/`<li>`/`<strong>`/`<br>` 以外の
  タグが出力に現れることは無い。** モデルの出力に `<script>` や
  `<img onerror=...>` が含まれていても、常にエスケープ済みの文字列
  （`&lt;script&gt;` 等）として表示されるだけで実行されないことを、
  `logic.test.ts` の文字列検証に加え、Playwrightで実際にブラウザに
  レンダリングして `alert()` が呼ばれないことも確認した（レビュー時の
  一時的な確認であり、リポジトリには追加していない）。
