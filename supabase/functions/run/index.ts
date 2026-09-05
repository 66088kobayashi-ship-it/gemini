// POST /run — { plan } を受け取り実行する。
// 順序: 1) JWT検証 2) allowlist照合 3) executeRunに委譲
//       （criteria検証→消費回数再計算→残量チェック→実行）4) 記録
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { handleRun } from "../_shared/http_handlers.ts";
import {
  createAdminClient,
  makeGetUsedToday,
  makeIsAllowlisted,
  makePersistRun,
  makeVerifyJwt,
} from "../_shared/supabase_adapters.ts";
import { makeOpenRouterCaller } from "../_shared/openrouter.ts";

const DAILY_LIMIT = Number(Deno.env.get("DAILY_QUOTA") ?? "50");
const CONTEXT_WINDOW = Number(Deno.env.get("CONTEXT_WINDOW") ?? "12");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method not allowed" });
  }

  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY が設定されていません");
    return jsonResponse(500, { error: "server misconfigured" });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON" });
  }

  const admin = createAdminClient();
  const result = await handleRun(req.headers.get("Authorization"), rawBody, {
    verifyJwt: makeVerifyJwt(admin),
    isAllowlisted: makeIsAllowlisted(admin),
    getUsedToday: makeGetUsedToday(admin),
    persistRun: makePersistRun(admin),
    callModel: makeOpenRouterCaller({ apiKey }),
    dailyLimit: DAILY_LIMIT,
    window: CONTEXT_WINDOW,
  });
  return jsonResponse(result.status, result.body);
});
