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

## セットアップ

### 1. Supabase プロジェクトを作る

1. https://supabase.com でプロジェクトを作成する。
2. `supabase/migrations/0001_init.sql` を SQL Editor で実行する
   （`allowlist` / `usage` / `runs` テーブルと RLS、`record_run()` 関数が作られる）。
3. `allowlist` テーブルに、使わせたいユーザーのメールアドレスを登録する。
   ```sql
   insert into allowlist (email, note) values ('you@example.com', '管理者');
   ```
4. **Authentication → Providers → Email** でマジックリンク（Email OTP）を有効にする
   （Google OAuth はまだ実装していない）。
5. **Authentication → URL Configuration** の Redirect URLs に、GitHub Pages の
   公開URL（例: `https://<user>.github.io/<repo>/`）を追加する。

### 2. Edge Function の Secrets を登録する

Supabase の **Project Settings → Edge Functions → Secrets**（または `supabase secrets set`）で:

| Secret 名             | 内容                                                  |
| ---------------------- | ----------------------------------------------------- |
| `OPENROUTER_API_KEY`   | OpenRouter の API キー                                |
| `DAILY_QUOTA`          | （任意）1日あたりの呼び出し上限。既定 50              |
| `CONTEXT_WINDOW`       | （任意）文脈窓の直近ターン数。既定 12                 |

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` は Supabase が自動で注入する。

キーは Edge Function の Secret にのみ置かれ、フロントのコード・ログ・
レスポンスには一切出力されない。

### 3. Edge Function をデプロイする

```
supabase functions deploy quota
supabase functions deploy run
```

### 4. フロントを設定する

`frontend/config.js` を編集する。

```js
window.YUI_CONFIG = {
  supabaseUrl: "https://xxxxxxxx.supabase.co",
  supabaseAnonKey: "ey...",       // anon/publicキー。公開して問題ない
  models: {
    // 有料に切り替えるときは model と display を必ず同時に書き換える
    // propose: { model: "anthropic/claude-sonnet-5", display: "Claude Sonnet 5" },
  },
};
```

`frontend/` を GitHub Pages のソースに設定する（Settings → Pages →
Source: Deploy from a branch → `/frontend`）。

## ローカルでのテスト実行

```
deno test frontend/ supabase/functions/_shared/
```

テストは HTTP を一切叩かない。API呼び出し・DB・認証はすべてスタブに
差し替えて、視点変換・巡回・消費計算・HTTPロジック・エラー文言を検証する。

## デプロイ前チェックリスト

- [x] JWTなし/allowlist外/criteria空/残量不足のいずれも `/run` が実際の
      呼び出しを1回もせずに拒否すること（`http_handlers.test.ts` で検証済み）
- [x] クライアントが偽の消費回数を送っても、サーバー側の再計算が使われること
- [x] 加算(`persistRun`)が失敗したとき、黙って200を返さないこと
- [ ] **`supabase start` のローカルPostgresに対し、同一ユーザーで `/run` を
      同時に複数投げ、`usage.calls` が全実行ぶん正しく積算されることを
      1度だけ確認する。** サンドボックスでは実際の同時実行を再現できないため、
      `record_run()` のアトミック性（`on conflict ... do update set
      calls = usage.calls + excluded.calls` という単一SQL文であること）は、
      現状「単一SQL文だから正しいはず」という推論に留まっている。
      本番投入前に一度だけ実測で埋めること。

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
- `/run` の処理順は「JWT検証 → allowlist照合 → criteria検証 → 消費回数の
  サーバー側再計算 → 残量チェック → 実行 → 加算・記録」。クライアントの
  申告値は一切使わない。
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
