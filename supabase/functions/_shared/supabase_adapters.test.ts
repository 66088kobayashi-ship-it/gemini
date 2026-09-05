import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { assert, assertEquals } from "./test_util.ts";
import {
  makeGetRunById,
  makeGetUsedToday,
  makeIsAllowlisted,
  makePersistRun,
  makeVerifyJwt,
} from "./supabase_adapters.ts";

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

// ---------------------------------------------------------------------------
// makeGetRunById: 再開のために、id と user_id の両方が一致する行だけを返す
// ---------------------------------------------------------------------------

Deno.test("makeGetRunById: id/user_idが一致すればplan/transcript/verdictを返す", async () => {
  const seenFilters: Array<{ col: string; val: string }> = [];
  const fakeAdmin = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (col1: string, val1: string) => {
          seenFilters.push({ col: col1, val: val1 });
          return {
            eq: (col2: string, val2: string) => {
              seenFilters.push({ col: col2, val: val2 });
              return {
                maybeSingle: async () => ({
                  data: {
                    plan: { before: [], loop: [{ role: "propose", model: "m" }], after: [], rounds: 2, criteria: "c", instruction: "i" },
                    transcript: [{ participantId: "loop:0", role: "propose", label: "提案", text: "t" }],
                    verdict: "FAIL",
                  },
                  error: null,
                }),
              };
            },
          };
        },
      }),
    }),
  } as unknown as SupabaseClient;
  const getRunById = makeGetRunById(fakeAdmin);
  const result = await getRunById("user-1", "run-1");
  assert(result !== null);
  assertEquals(result?.verdict, "FAIL");
  assertEquals(result?.plan.loop.length, 1);
  assertEquals(seenFilters, [
    { col: "id", val: "run-1" },
    { col: "user_id", val: "user-1" },
  ]);
});

Deno.test("makeGetRunById: 行が見つからなければnull（他人の実行/存在しない実行の両方）", async () => {
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
  const getRunById = makeGetRunById(fakeAdmin);
  assertEquals(await getRunById("user-1", "someone-elses-run"), null);
});

Deno.test("makeGetRunById: クエリ自体が失敗してもnull（握りつぶさずログには残す）", async () => {
  const fakeAdmin = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_c1: string, _v1: string) => ({
          eq: (_c2: string, _v2: string) => ({
            maybeSingle: async () => ({ data: null, error: { message: "invalid input syntax for type uuid" } }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  const getRunById = makeGetRunById(fakeAdmin);
  assertEquals(await getRunById("user-1", "not-a-uuid"), null);
});
