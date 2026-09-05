-- 結: allowlist / usage / runs
-- usage.day は UTC。engine.ts の utcDay() が返す文字列と揃える。

create extension if not exists pgcrypto;

create table if not exists allowlist (
  email text primary key,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists usage (
  user_id uuid not null,
  day date not null,
  calls int not null default 0,
  primary key (user_id, day)
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  plan jsonb not null,
  transcript jsonb not null,
  calls_planned int not null,
  calls_actual int not null,
  verdict text,
  created_at timestamptz not null default now()
);

alter table allowlist enable row level security;
alter table usage enable row level security;
alter table runs enable row level security;

-- allowlist: anon/authenticated には一切 grant しない。
-- service role（Edge Function）は RLS をバイパスするので、常に読める。
revoke all on allowlist from anon, authenticated;

-- usage / runs: 本人の行のみ SELECT 可。INSERT/UPDATE はクライアントからはできない
-- （grant していない）。書き込みは service role 経由の record_run() のみ。
grant usage on schema public to authenticated;
grant select on usage to authenticated;
grant select on runs to authenticated;

create policy "usage_select_own" on usage
  for select
  using (auth.uid() = user_id);

create policy "runs_select_own" on runs
  for select
  using (auth.uid() = user_id);

-- 使用量の加算と実行記録の保存をアトミックに行う。
-- 呼び出し側（Edge Function）は必ずこの関数を1回呼ぶだけにし、
-- 「読んでから書く」形の別々の SELECT + UPDATE に分解しないこと。
-- 同時実行で加算が失われる（lost update）のを防ぐため。
create or replace function record_run(
  p_user_id uuid,
  p_day date,
  p_calls_actual int,
  p_plan jsonb,
  p_transcript jsonb,
  p_calls_planned int,
  p_verdict text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
begin
  insert into usage (user_id, day, calls)
  values (p_user_id, p_day, p_calls_actual)
  on conflict (user_id, day)
  do update set calls = usage.calls + excluded.calls;

  insert into runs (user_id, plan, transcript, calls_planned, calls_actual, verdict)
  values (p_user_id, p_plan, p_transcript, p_calls_planned, p_calls_actual, p_verdict)
  returning id into v_run_id;

  return v_run_id;
end;
$$;

revoke all on function record_run(uuid, date, int, jsonb, jsonb, int, text) from public;
grant execute on function record_run(uuid, date, int, jsonb, jsonb, int, text) to service_role;
