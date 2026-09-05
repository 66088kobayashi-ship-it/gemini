import { assertEquals } from "../_shared/test_util.ts";
import { handleQuotaRequest, QuotaDeps } from "./handler.ts";
import { AuthContext } from "../_shared/http_handlers.ts";

const OK_AUTH: AuthContext = { userId: "user-1", email: "ok@example.com" };
const NO_KEY_ENV = (_name: string): string | undefined => undefined;

function makeRequest(authHeader: string | null): Request {
  const headers = new Headers();
  if (authHeader !== null) headers.set("Authorization", authHeader);
  return new Request("https://example.com/quota", { method: "GET", headers });
}

Deno.test("handleQuotaRequest: OPENROUTER_API_KEY未設定でも正常に応答する（quotaはそもそも使わない）", async () => {
  const deps: QuotaDeps = {
    getEnv: NO_KEY_ENV,
    verifyJwt: async () => OK_AUTH,
    getUsedToday: async () => 12,
  };
  const res = await handleQuotaRequest(makeRequest("Bearer good-jwt"), deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body, { used: 12, limit: 50, remaining: 38 });
});

Deno.test("handleQuotaRequest: JWTなしは401", async () => {
  const deps: QuotaDeps = {
    getEnv: NO_KEY_ENV,
    verifyJwt: async () => null,
    getUsedToday: async () => 0,
  };
  const res = await handleQuotaRequest(makeRequest(null), deps);
  assertEquals(res.status, 401);
});
