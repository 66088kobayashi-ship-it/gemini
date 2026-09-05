// POST /run のSupabaseエントリポイント。判定ロジックは一切ここに置かない
// （handler.ts に切り出してテストする）。Deno.serve はこれを呼ぶだけ。
import { handleRunRequest } from "./handler.ts";

Deno.serve((req) => handleRunRequest(req));
