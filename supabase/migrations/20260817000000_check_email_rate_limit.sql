-- Per-IP rate limiting for check-email-exists, which pages through
-- auth.admin.listUsers() (up to 50 pages of 1000 users each) on every call
-- and is reachable by anyone with the publishable key, no auth required
-- (guests use it on the account gate's email step). Without a limit, a
-- scripted caller could both run up admin-API/DB cost and use the endpoint's
-- boolean response as a mass email-enumeration oracle. See that function's
-- own top-of-file comment for why the response is deliberately limited to a
-- single boolean already -- this closes the remaining "call it as fast as
-- you want" gap.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE).

create table if not exists public.check_email_rate_limits (
  ip text primary key,
  window_start timestamptz not null default now(),
  request_count integer not null default 0
);

-- RLS enabled with no policies at all, and no GRANTs below to anon/
-- authenticated -- this table is never read or written by anything except
-- the service-role client inside check-email-exists (service_role bypasses
-- RLS entirely, same as every other admin-only table in this project), so
-- there's nothing for a client-side policy to allow.
alter table public.check_email_rate_limits enable row level security;

-- Atomic fixed-window counter: one round trip, one row lock, so concurrent
-- requests from the same IP can't race a separate select-then-update into
-- under-counting. If the existing window has expired, both the count and
-- window_start reset; otherwise the count just increments. Returns the
-- count *after* this request, so the caller can compare it against its own
-- limit.
create or replace function public.check_email_rate_limit(
  p_ip text,
  p_window_seconds integer
)
returns integer
language sql
security definer
set search_path = public
volatile
as $$
  insert into public.check_email_rate_limits (ip, window_start, request_count)
  values (p_ip, now(), 1)
  on conflict (ip) do update set
    request_count = case
      when public.check_email_rate_limits.window_start <= now() - make_interval(secs => p_window_seconds)
        then 1
      else public.check_email_rate_limits.request_count + 1
    end,
    window_start = case
      when public.check_email_rate_limits.window_start <= now() - make_interval(secs => p_window_seconds)
        then now()
      else public.check_email_rate_limits.window_start
    end
  returning request_count;
$$;

-- Only the function owner can execute a security-definer function by
-- default -- same reasoning as public.is_admin_user() in
-- 20260806000100_fix_admin_rls_recursion.sql. Only service_role ever calls
-- this (see check-email-exists/index.ts), so that's the only grant needed.
grant execute on function public.check_email_rate_limit(text, integer) to service_role;
