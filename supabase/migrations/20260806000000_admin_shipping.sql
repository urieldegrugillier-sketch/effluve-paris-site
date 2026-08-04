-- First piece of a broader admin interface (admin.html): marking orders as
-- shipped with a tracking number. Reuses the existing Supabase Auth +
-- public.profiles infrastructure rather than a separate admin password
-- system -- an is_admin flag on profiles, checked both client-side (to gate
-- admin.html itself) and via RLS (the actual enforcement boundary -- the
-- client-side check alone is just UX, never trust-worthy on its own).
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>` (see
-- README/recent session notes on why `supabase db push` doesn't work for
-- this project's migration history). Safe to run more than once (IF NOT
-- EXISTS / OR REPLACE / DROP POLICY IF EXISTS before each CREATE POLICY).

-- ============================================================================
-- 1. is_admin flag
-- ============================================================================
-- Not exposed anywhere in the normal account.html profile UI -- only ever
-- set directly via SQL Editor / this migration's own follow-up UPDATE for a
-- specific trusted account. Future admin sections (stock editor, promo
-- timer/code editor) reuse this exact same flag rather than each inventing
-- their own permission check.
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

-- ============================================================================
-- 2. Shipping fields on orders
-- ============================================================================
alter table public.orders
  add column if not exists shipping_status text not null default 'pending';

alter table public.orders
  add column if not exists tracking_number text;

-- ============================================================================
-- 3. RLS: admins can read every order (not just their own) and every
--    profile (to show the customer's name next to each order) -- additive
--    to the existing customer-scoped "Users can view own X" policies below
--    (Postgres OR's every matching policy together for the same command;
--    this doesn't replace or narrow what a regular customer can already see
--    of their own data).
-- ============================================================================
drop policy if exists "Admins can view all orders" on public.orders;
create policy "Admins can view all orders"
  on public.orders
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

-- Self-referencing (profiles' own policy queries profiles) -- this is the
-- standard, safe pattern for an is_admin check: the inner query resolves via
-- the existing "Users can view own profile" policy (auth.uid() = id) for the
-- admin's own row, which is what actually authorizes the outer policy to
-- then apply to every OTHER row too. No infinite recursion -- the base case
-- (a user can always see their own profile) already terminates it.
drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles"
  on public.profiles
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

-- ============================================================================
-- 4. RLS + column grant: only admins can update shipping_status/
--    tracking_number, and even then ONLY those two columns -- RLS alone is
--    row-level, not column-level, so the USING/WITH CHECK policy below (who
--    can update which ROWS) is paired with a column-scoped GRANT (which
--    COLUMNS the authenticated role can touch at all). A non-admin fails at
--    the policy; an admin trying to touch any other column (total, status,
--    reference_number, ...) fails at the grant, before RLS is even
--    consulted. authenticated has never had any UPDATE grant on this table
--    at all until now (see 20260802000000_add_order_payment_tracking.sql's
--    own comment on why: a client rewriting its own total/status would be
--    able to fake a paid order it never actually paid for -- that boundary
--    is untouched, this only opens two new, narrow, admin-gated columns).
-- ============================================================================
drop policy if exists "Admins can update shipping fields" on public.orders;
create policy "Admins can update shipping fields"
  on public.orders
  for update
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

grant update (shipping_status, tracking_number) on public.orders to authenticated;
