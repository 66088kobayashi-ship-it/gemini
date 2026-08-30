# gemini

Claude と Gemini を自動で往復対話させる GitHub Actions ランナー。

## 構成

```
dialogue.py                        # 対話ランナー本体（CLI）
.github/workflows/dialogue.yml     # workflow_dispatch で起動
tests/test_dialogue.py             # 標準 unittest（ネットワーク不使用）
transcripts/                       # 対話ログの出力先
```

依存はすべて Python 標準ライブラリのみ（`urllib.request`）。サードパーティ
パッケージは一切追加していない。

## セットアップ

### 1. API キーを Secrets に登録する

このリポジトリの **Settings → Secrets and variables → Actions** で以下の
Repository secret を登録する。

| Secret 名           | 内容                                   |
| -------------------- | -------------------------------------- |
| `ANTHROPIC_API_KEY`  | Anthropic の API キー                  |
| `GEMINI_API_KEY`     | Google AI Studio / Gemini の API キー  |

キーはコード・ログ・コミットのどこにも出力されない。Gemini 側はヘッダ
(`x-goog-api-key`) で送るため、URL クエリに載ってログに残ることもない。

### 2. モデルを変更したい場合（任意）

既定モデルは以下。変更したい場合はワークフロー内の `env` か、実行環境の
環境変数で上書きする。

- `CLAUDE_MODEL`（既定: `claude-sonnet-5`）
- `GEMINI_MODEL`（既定: `gemini-3.7-flash`）

## 実行方法（iPad / Web UI から）

1. GitHub の **Actions** タブを開く。
2. 左側の **Claude x Gemini Dialogue** ワークフローを選ぶ。
3. **Run workflow** をクリックし、以下を入力する。
   - `topic`: 対話のお題（必須）
   - `turns`: 最大ターン数。40 を超える値は実行前に拒否される（既定 6）
   - `first`: 先攻を `claude` / `gemini` から選択
   - `claude_persona` / `gemini_persona`: 各AIのペルソナ（任意）
4. 実行するとログがストリーミングされ、各ターンの発言がその場で流れる。
5. 対話終了後、`transcripts/YYYYMMDD-HHMMSS.md` が自動でコミット・push
   されるほか、ワークフローの Artifact としてもダウンロードできる。

## ローカルでのテスト実行

```
python -m unittest discover -s tests
```

テストは HTTP を一切叩かず、API 呼び出し関数をスタブに差し替えて
変換ロジック・対話ループ・リトライ・停止条件を検証する。

## 設計のポイント

- 会話ログは話者と発言だけを持つ中立な `transcript` として保持し、API を
  呼ぶ直前に呼ぶ側の視点（Anthropic: 自分=assistant/相手=user、
  Gemini: 自分=model/相手=user）に変換する
  （`to_anthropic_messages` / `to_gemini_contents`）。
- お題は毎ターンの system prompt に明記する。文脈窓を切り詰めても、
  後攻側がお題を見失わないようにするため。
- `--window` で直近 N ターンのみを API に渡す。窓を切った結果、配列の
  先頭が「自分の発言」になる場合は、その分の内容が正しくないため
  そのターン分を破棄している。
- 429 / 5xx は指数バックオフで最大4回リトライ。それ以外の 4xx は
  設定ミスとして即座に例外にする。
- `--turns` が 40 を超える場合は実行前に終了する（暴走防止）。
- Anthropic の thinking ブロック、Gemini の `thought` パートは、
  本文として扱わず除外する。
- Anthropic への呼び出しに `temperature` / `top_p` は送らない
  （Sonnet 5 系は非デフォルトの sampling parameter を拒否し 400 になる）。
