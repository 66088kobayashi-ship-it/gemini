import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { assert, assertEquals } from "./test_util.ts";
import { makeGetUsedToday, makeIsAllowlisted, makePersistRun, makeVerifyJwt } from "./supabase_adapters.ts";

// 実の SupabaseClient は postgrest-js の複雑なビルダー型を持つため、テストでは
// 実際に叩かれるメソッドだけを持つ最小のフェイクを作り、unknown 経由でキャストする。
// （本番コードは npm:@supabase/supabase-js の SupabaseClient 型をそのまま使うので、
// 実クライアントを渡した場合の型チェックは deno check 側で担保される）

Deno.test("makePersistRun: record_run を1回だけ呼ぶ（read-then-writeに分解していない）", async () => {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const fakeAdmin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: "run-abc", error: null };
    },
  } as unknown as SupabaseClient;
  const persistRun = makePersistRun(fakeAdmin);
  const result = await persistRun({
    userId: "u1",
    day: "2026-09-04",
    callsActual: 6,
    callsPlanned: 6,
    plan: { before: [], loop: [], after: [], rounds: 1, criteria: "x", instruction: "y" },
    transcript: [],
    verdict: null,
  });
  assertEquals(result.ok, true);
  assertEquals(result.runId, "run-abc");
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0].fn, "record_run");
  assertEquals(rpcCalls[0].args.p_calls_actual, 6);
});

Deno.test("makePersistRun: RPCがエラーを返したら ok:false を返す（握りつぶさない）", async () => {
  const fakeAdmin = {
    rpc: async () => ({ data: null, error: { message: "constraint violation" } }),
  } as unknown as SupabaseClient;
  const persistRun = makePersistRun(fakeAdmin);
  const result = await persistRun({
    userId: "u1",
    day: "2026-09-04",
    callsActual: 3,
    callsPlanned: 3,
    plan: { before: [], loop: [], after: [], rounds: 1, criteria: "x", instruction: "y" },
    transcript: [],
    verdict: null,
  });
  assertEquals(result.ok, false);
  assert(result.error?.includes("constraint violation"));
});

Deno.test("makeIsAllowlisted: 見つかれば true", async () => {
  const fakeAdmin = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => ({ data: { email: "ok@example.com" }, error: null }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  const isAllowlisted = makeIsAllowlisted(fakeAdmin);
  assertEquals(await isAllowlisted("ok@example.com"), true);
});

Deno.test("makeIsAllowlisted: 見つからなければ false", async () => {
  const fakeAdmin = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  const isAllowlisted = makeIsAllowlisted(fakeAdmin);
  assertEquals(await isAllowlisted("nope@example.com"), false);
});

Deno.test("makeGetUsedToday: 行が無ければ 0", async () => {
  const fakeAdmin = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_c1: string, _v1: string) => ({
          eq: (_c2: string, _v2: string) => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  const getUsedToday = makeGetUsedToday(fakeAdmin);
  assertEquals(await getUsedToday("u1", "2026-09-04"), 0);
});

Deno.test("makeVerifyJwt: Authorizationヘッダが無ければ null（getUserを呼ばない）", async () => {
  let called = false;
  const fakeAdmin = {
    auth: {
      getUser: async (_jwt: string) => {
        called = true;
        return { data: { user: null }, error: null };
      },
    },
  } as unknown as SupabaseClient;
  const verifyJwt = makeVerifyJwt(fakeAdmin);
  const result = await verifyJwt(null);
  assertEquals(result, null);
  assertEquals(called, false);
});

Deno.test("makeVerifyJwt: 不正なトークンは null（ブラウザの状態を信用しない）", async () => {
  const fakeAdmin = {
    auth: {
      getUser: async (_jwt: string) => ({ data: { user: null }, error: { message: "invalid" } }),
    },
  } as unknown as SupabaseClient;
  const verifyJwt = makeVerifyJwt(fakeAdmin);
  const result = await verifyJwt("Bearer invalid-token");
  assertEquals(result, null);
});
