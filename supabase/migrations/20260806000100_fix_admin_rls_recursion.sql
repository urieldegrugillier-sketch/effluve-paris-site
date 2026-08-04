-- BUG FIX: the three "Admins can ..." policies added in
-- 20260806000000_admin_shipping.sql each checked admin status via an inline
-- `exists (select 1 from public.profiles p where p.id = auth.uid() and
-- p.is_admin = true)` subquery. That subquery itself touches
-- public.profiles, which is ALSO RLS-protected -- once profiles had a
-- SECOND select policy (both "Users can view own profile" AND "Admins can
-- view all profiles" stacked), Postgres's own policy evaluation recurses
-- into re-evaluating "Admins can view all profiles" while it's already
-- evaluating that same policy for the outer query, with no cycle detection.
-- Confirmed live testing this migration: "ERROR: 42P17: infinite recursion
-- detected in policy for relation profiles" on the very first real query
-- against it (a non-admin session's own SELECT on orders).
--
-- Standard fix: move the is_admin check into a SECURITY DEFINER function.
-- Its internal query runs as the function's OWNER, not as the calling
-- `authenticated` role -- that bypasses profiles' own RLS entirely for this
-- one lookup, so there's nothing left for Postgres to recurse into.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (CREATE OR REPLACE / DROP POLICY IF EXISTS).

create or replace function public.is_admin_user()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- Only the function owner can execute a security-definer function by
-- default -- without this, `authenticated` calling it from inside an RLS
-- policy would itself fail with a permission error.
grant execute on function public.is_admin_user() to authenticated;

drop policy if exists "Admins can view all orders" on public.orders;
create policy "Admins can view all orders"
  on public.orders
  for select
  to authenticated
  using (public.is_admin_user());

drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles"
  on public.profiles
  for select
  to authenticated
  using (public.is_admin_user());

drop policy if exists "Admins can update shipping fields" on public.orders;
create policy "Admins can update shipping fields"
  on public.orders
  for update
  to authenticated
  using (public.is_admin_user())
  with check (public.is_admin_user());
