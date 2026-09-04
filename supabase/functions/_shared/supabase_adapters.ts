// http_handlers.ts の各 Fn 型を、実際の Supabase (supabase-js) につなぐ実装。
// ここは実ネットワークに出るため deno test の対象にしない
// （http_handlers.test.ts / supabase_adapters.test.ts がスタブでロジックを検証する）。
// 依存は Supabase クライアントのみ。

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type {
  GetUsedTodayFn,
  IsAllowlistedFn,
  PersistRunFn,
  VerifyJwtFn,
} from "./http_handlers.ts";

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`環境変数 ${name} が設定されていません`);
  return v;
}

/** JWT検証・allowlist照合・usage/runsへの書き込みをすべて service role で行う。
 * allowlist はクライアントから読めない設計なので、これは意図的。 */
export function createAdminClient(): SupabaseClient {
  const url = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Authorization: Bearer <jwt> をサーバー側で検証する。
 * ここでの「検証」は Supabase Auth サーバーへの問い合わせであり、
 * ブラウザの状態（ログイン済みフラグ等）は一切信用しない。 */
export function makeVerifyJwt(admin: SupabaseClient): VerifyJwtFn {
  return async (authHeader) => {
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
    const jwt = authHeader.slice("Bearer ".length).trim();
    if (!jwt) return null;

    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user?.email) return null;
    return { userId: data.user.id, email: data.user.email };
  };
}

export function makeIsAllowlisted(admin: SupabaseClient): IsAllowlistedFn {
  return async (email) => {
    const { data, error } = await admin
      .from("allowlist")
      .select("email")
      .eq("email", email)
      .maybeSingle();
    if (error) {
      console.error("allowlist照合に失敗しました:", error.message);
      return false;
    }
    return data !== null;
  };
}

export function makeGetUsedToday(admin: SupabaseClient): GetUsedTodayFn {
  return async (userId, day) => {
    const { data, error } = await admin
      .from("usage")
      .select("calls")
      .eq("user_id", userId)
      .eq("day", day)
      .maybeSingle();
    if (error) {
      console.error("usage取得に失敗しました:", error.message);
      throw new Error("usage取得に失敗しました");
    }
    return (data as { calls: number } | null)?.calls ?? 0;
  };
}

/** usage への加算と runs への記録を、record_run() 1回の呼び出しで
 * アトミックに行う。read-then-write（select してから update）に
 * 分解しないこと。同時実行で加算が失われる。 */
export function makePersistRun(admin: SupabaseClient): PersistRunFn {
  return async (input) => {
    const { data, error } = await admin.rpc("record_run", {
      p_user_id: input.userId,
      p_day: input.day,
      p_calls_actual: input.callsActual,
      p_plan: input.plan,
      p_transcript: input.transcript,
      p_calls_planned: input.callsPlanned,
      p_verdict: input.verdict,
    });
    if (error) {
      console.error("record_run に失敗しました:", error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true, runId: data as string };
  };
}
