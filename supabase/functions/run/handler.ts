// POST /run の実体。Deno.serve コールバックを薄く保ち、ここを直接
// deno test でテストできるようにする（ネットワーク・実サーバー起動なし）。
//
// 重大な教訓（実機で一度発生したバグ）: OPENROUTER_API_KEY の有無チェックを
// handleRun より前に置いたことがあり、これが JWT検証・allowlist照合よりも
// 前に実行される「第二の入場チェック」になっていた。allowlist に載っていない
// リクエストが、キーさえ設定されていれば OpenRouter 呼び出しの経路まで
// 到達できてしまう状態だった。
//
// 教訓: エントリポイント（Deno.serve のコールバック）に判定ロジックを
// 置かない。認証・認可より前に分岐点を作らない。ここでは OPENROUTER_API_KEY
// の読み取りを、handleRun がすべての判定（JWT→allowlist→criteria/instruction→
// 残量）を通過し、実際にモデルを呼ぶ直前まで遅らせる（makeLazyCallModel）。

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import {
  GetUsedTodayFn,
  handleRun,
  IsAllowlistedFn,
  PersistRunFn,
  VerifyJwtFn,
} from "../_shared/http_handlers.ts";
import { CallModelFn } from "../_shared/engine.ts";
import {
  createAdminClient,
  makeGetUsedToday,
  makeIsAllowlisted,
  makePersistRun,
  makeVerifyJwt,
} from "../_shared/supabase_adapters.ts";
import {
  EmptyResponseError,
  InsufficientBalanceError,
  makeOpenRouterCaller,
  RateLimitedError,
  UpstreamErrorResponse,
} from "../_shared/openrouter.ts";

export interface RunDeps {
  getEnv: (name: string) => string | undefined;
  verifyJwt: VerifyJwtFn;
  isAllowlisted: IsAllowlistedFn;
  getUsedToday: GetUsedTodayFn;
  persistRun: PersistRunFn;
  /** 省略時は getEnv から OPENROUTER_API_KEY を遅延取得する実アダプタを使う。
   * テストではカウント用スタブに差し替える。 */
  callModel?: CallModelFn;
}

/** OPENROUTER_API_KEY を、実際に呼ばれた瞬間まで読まない CallModelFn。
 * handleRun が JWT/allowlist/criteria/instruction/残量のすべてを通過し、
 * runPlan が実際にモデルを呼ぼうとした時だけ評価される。 */
function makeLazyCallModel(getEnv: (name: string) => string | undefined): CallModelFn {
  return (args) => {
    const apiKey = getEnv("OPENROUTER_API_KEY");
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY が設定されていません");
    }
    return makeOpenRouterCaller({ apiKey })(args);
  };
}

function buildDefaultDeps(): RunDeps {
  const admin = createAdminClient();
  return {
    getEnv: (name) => Deno.env.get(name),
    verifyJwt: makeVerifyJwt(admin),
    isAllowlisted: makeIsAllowlisted(admin),
    getUsedToday: makeGetUsedToday(admin),
    persistRun: makePersistRun(admin),
  };
}

export async function handleRunRequest(req: Request, deps?: RunDeps): Promise<Response> {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method not allowed" });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON" });
  }

  try {
    const d = deps ?? buildDefaultDeps();
    const dailyLimit = Number(d.getEnv("DAILY_QUOTA") ?? "50");
    const window = Number(d.getEnv("CONTEXT_WINDOW") ?? "12");

    const result = await handleRun(req.headers.get("Authorization"), rawBody, {
      verifyJwt: d.verifyJwt,
      isAllowlisted: d.isAllowlisted,
      getUsedToday: d.getUsedToday,
      persistRun: d.persistRun,
      callModel: d.callModel ?? makeLazyCallModel(d.getEnv),
      dailyLimit,
      window,
    });
    return jsonResponse(result.status, result.body);
  } catch (e) {
    if (e instanceof InsufficientBalanceError) {
      return jsonResponse(402, { error: e.message });
    }
    if (e instanceof RateLimitedError) {
      // 429はモデル側の一時的な混雑。402(残高不足)や404(モデルID誤り)とは
      // 原因が違うので、専用のステータスのまま返す（500に丸めない）。
      return jsonResponse(429, { error: e.message });
    }
    if (e instanceof EmptyResponseError || e instanceof UpstreamErrorResponse) {
      // モデルが実質的に応答しなかったケース（200だがcontentが無い/
      // choicesが空/トップレベルにerrorが入っている）。402(残高不足)や
      // 429(混雑)、404(モデルID誤り)とは原因が違うので、専用のステータス
      // のまま返す（500に丸めない。フロントが「別のモデルを試す」という
      // 具体的な次の一手を案内できるようにする）。
      return jsonResponse(502, { error: e.message });
    }
    // それ以外（truncation等）の診断情報は、キー・トークンの
    // 中身を含まない形で構築済みなので、サーバーログにそのまま残す。
    console.error("run failed:", e instanceof Error ? e.message : String(e));
    return jsonResponse(500, { error: "server misconfigured" });
  }
}
