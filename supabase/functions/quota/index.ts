// GET /quota — { used, limit, remaining }（UTCの当日）
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { handleQuota } from "../_shared/http_handlers.ts";
import { createAdminClient, makeGetUsedToday, makeVerifyJwt } from "../_shared/supabase_adapters.ts";

const DAILY_LIMIT = Number(Deno.env.get("DAILY_QUOTA") ?? "50");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();

  const admin = createAdminClient();
  const result = await handleQuota(req.headers.get("Authorization"), {
    verifyJwt: makeVerifyJwt(admin),
    getUsedToday: makeGetUsedToday(admin),
    dailyLimit: DAILY_LIMIT,
  });
  return jsonResponse(result.status, result.body);
});
