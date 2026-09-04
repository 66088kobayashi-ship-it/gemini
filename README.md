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
      supabase_adapters.test.ts
      cors.ts
      test_util.ts                 # 自前の最小アサーション（外部依存なし）
    quota/index.ts                 # GET /quota のエントリポイント
    run/index.ts                   # POST /run のエントリポイント
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

### 2. Edge Function の Secrets を登録する

Supabase ダッシュボードの **Project Settings → Edge Functions → Secrets** で:

| Secret 名             | 内容                                                  |
| ---------------------- | ----------------------------------------------------- |
| `OPENROUTER_API_KEY`   | OpenRouter の API キー                                |
| `DAILY_QUOTA`          | （任意）1日あたりの呼び出し上限。既定 50              |
| `CONTEXT_WINDOW`       | （任意）文脈窓の直近ターン数。既定 12                 |

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` は Supabase が自動で注入する。

キーは Edge Function の Secret にのみ置かれ、フロントのコード・ログ・
レスポンスには一切出力されない。

### 3. Edge Function をデプロイする

Supabase CLI が使える環境（Docker不要、`npx supabase` で動く）から:

```
supabase link --project-ref <あなたのプロジェクトref>
supabase functions deploy quota
supabase functions deploy run
```

ローカル環境が無い場合は、Supabase ダッシュボードの **Edge Functions** 画面
から直接コードを貼り付けてデプロイすることもできる
（`supabase/functions/quota/index.ts` と `supabase/functions/run/index.ts`、
および両方が import する `_shared/` 配下一式が必要）。

### 4. フロントを設定する

`frontend/config.js` を GitHub の Web UI で直接編集する。

```js
window.YUI_CONFIG = {
  supabaseUrl: "https://xxxxxxxx.supabase.co",   // Project Settings → API → Project URL
  supabaseAnonKey: "ey...",                       // Project Settings → API → anon public
  models: {
    // 有料に切り替えるときは model と display を必ず同時に書き換える
    // propose: { model: "anthropic/claude-sonnet-5", display: "Claude Sonnet 5" },
  },
};
```

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

## デプロイ前チェックリスト

上から順に実行する。

- [ ] `supabase/migrations/0001_init.sql` を適用した
- [ ] `allowlist` に自分のメールアドレスを1件入れた
- [ ] マジックリンクの送信元メール設定を確認した（Authentication → Emails）
- [ ] Edge Function の Secret に `OPENROUTER_API_KEY` を設定した
- [ ] `quota` / `run` の Edge Function をデプロイした
- [ ] https://openrouter.ai/models で、既定モデルID（`frontend/index.html`
      の `DEFAULT_MODEL_CONFIG`、`:free` 付き）が現存するか確認した。
      無料枠カタログは入れ替わるため、無くなっていたら
      `frontend/config.js` の `models` で存命のモデルに上書きする
- [ ] `frontend/config.js` に実際の Supabase URL / anon key を入れた
      （service role key ではないことを再確認した）
- [ ] GitHub Pages を有効にした（Source: root）
- [ ] Supabase の Site URL / Redirect URLs に GitHub Pages の公開URLを登録した
- [x] JWTなし/allowlist外/criteria空/instruction空/残量不足のいずれも
      `/run` が実際の呼び出しを1回もせずに拒否すること
      （`http_handlers.test.ts` で検証済み）
- [x] クライアントが偽の消費回数を送っても、サーバー側の再計算が使われること
      （検証済み）
- [x] 加算(`persistRun`)が失敗したとき、黙って200を返さないこと（検証済み）
- [ ] **`supabase start` のローカルPostgresに対し、同一ユーザーで `/run` を
      同時に複数投げ、`usage.calls` が全実行ぶん正しく積算されることを
      1度だけ確認する。** サンドボックスでは実際の同時実行を再現できないため、
      `record_run()` のアトミック性（`on conflict ... do update set
      calls = usage.calls + excluded.calls` という単一SQL文であること）は、
      現状「単一SQL文だから正しいはず」という推論に留まっている。
      本番投入前に一度だけ実測で埋めること。
      **これだけは iPad 単体では完結せず、Docker が動くPCが別途必要。**

## 実機での動作確認手順

課金や誤動作が起きにくい順に並べてある。上から順に進め、崩れたら
そこで止めて確認する。

1. **ログイン** — マジックリンクを受信し、リンクから戻ってきてセッションが
   乗る（画面が `#gate` から輪の画面に切り替わる）ことを確認する
2. **allowlist外での拒否** — `allowlist` に登録していない別のメール
   アドレスでログインを試み、`/run` が 403 になることを確認する
   （403の文言が表示され、APIは呼ばれない）
3. **criteria空での拒否** — 条件欄を空のまま実行し、400になり
   OpenRouterが呼ばれていないことを確認する（OpenRouter側の使用量画面等で
   増えていないことも見る）
4. **instruction空での拒否** — 条件は書くが指示欄を空のまま送信を試み、
   400になりAPIが呼ばれないことを確認する
5. **最小実行** — 役を2つ（無料モデル）、1周だけで実行し、実際に
   OpenRouterから応答が返ってくることを確認する
6. **残量の反映** — 実行後に上部の残量表示が減っていること、
   `/quota` を再取得した値と一致していることを確認する
7. **3人×3周** — 発言者名（`[役名]`）が各発言の前に付いていることを、
   返ってきた文面から確認する
8. **5周以上を1回だけ回し、後半で出力が崩れないかを目視する**
   （「既知の挙動」に書いた instruction の窓外脱落が実害を出すかどうかの
   確認。後半のターンで、モデルが「何を作っているか」を見失った
   ような応答（条件は満たそうとするが話題がずれる、等）が出たら、
   その内容を報告してほしい。対処（system promptへの再掲）はそれを見てから決める）

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
- 使用量の加算（`usage`）と実行記録（`runs`）は、Postgresの `record_run()`
  という単一のSQL文でアトミックに行う。Edge Function 側は read-then-write
  に分解しない。加算に失敗したら黙って200を返さず、207で明示する。
- 日付境界は UTC（`usage.day`）。JSTの0時ではリセットされない。
- OpenRouterの429/5xxは指数バックオフで最大4回リトライ。402（残高不足）は
  専用のエラーとして扱う。それ以外の4xxは即座に失敗させる。
- 表示名（`display`）と実モデルID（`model`）は別フィールドで持つ。無料枠の
  間は `display` に実際のモデル名を入れ、表示が嘘にならないようにする。
  役の色・アイコンは役に紐付いているので、モデルを差し替えても図は壊れない。
- 既定モデルは無料枠（`:free`）。有料モデルを既定にはしていない。
