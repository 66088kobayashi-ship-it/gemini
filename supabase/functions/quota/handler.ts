// GET /quota の実体。run/handler.ts と同じ理由で、Deno.serve コールバックを
// 薄く保ち、ここを直接 deno test でテストする。
// quota は OpenRouter を呼ばないため今回のバグの対象ではなかったが、
// エントリポイントに判定ロジックを置かないという原則は同じ形で適用する。

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { GetUsedTodayFn, handleQuota, VerifyJwtFn } from "../_shared/http_handlers.ts";
import { createAdminClient, makeGetUsedToday, makeVerifyJwt } from "../_shared/supabase_adapters.ts";

export interface QuotaDeps {
  getEnv: (name: string) => string | undefined;
  verifyJwt: VerifyJwtFn;
  getUsedToday: GetUsedTodayFn;
}

function buildDefaultDeps(): QuotaDeps {
  const admin = createAdminClient();
  return {
    getEnv: (name) => Deno.env.get(name),
    verifyJwt: makeVerifyJwt(admin),
    getUsedToday: makeGetUsedToday(admin),
  };
}

export async function handleQuotaRequest(req: Request, deps?: QuotaDeps): Promise<Response> {
  if (req.method === "OPTIONS") return corsPreflight();

  try {
    const d = deps ?? buildDefaultDeps();
    const dailyLimit = Number(d.getEnv("DAILY_QUOTA") ?? "50");
    const result = await handleQuota(req.headers.get("Authorization"), {
      verifyJwt: d.verifyJwt,
      getUsedToday: d.getUsedToday,
      dailyLimit,
    });
    return jsonResponse(result.status, result.body);
  } catch (e) {
    console.error("quota failed:", e instanceof Error ? e.message : String(e));
    return jsonResponse(500, { error: "server misconfigured" });
  }
}
