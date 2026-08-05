-- Two independent additions, bundled in one migration since both extend
-- public.promo_codes and neither depends on the other:
--
-- 1. Admin write access (admin.html's new "Codes Promo" tab) -- same
--    is_admin_user()-gated pattern as 20260806000100_fix_admin_rls_recursion.sql's
--    orders/profiles policies, extended here to INSERT/UPDATE on
--    promo_codes. Column-scoped grants (not a blanket GRANT UPDATE), same
--    reasoning as 20260806000000_admin_shipping.sql's own
--    `grant update (shipping_status, tracking_number)`: an admin editing an
--    existing code can only ever touch discount_percent/active/max_uses/
--    expires_at -- never times_used (only ever written by
--    increment_promo_code_usage() below) or code/id/created_at (renaming a
--    live code out from under checkout would silently invalidate whatever a
--    customer already has applied).
--
-- 2. times_used tracking -- BUG FIX: 20260729120000_add_promo_codes_table.sql's
--    own comment flagged this as a known gap ("times_used is NOT incremented
--    anywhere yet -- there's no order-completion webhook ... to hook that
--    into safely"). supabase/functions/stripe-webhook is now exactly that
--    webhook -- this SECURITY DEFINER function is called from its
--    reconcileOrder(), once per order, the FIRST time it turns 'paid' (same
--    call sites as sendOrderConfirmation(), which has the same
--    once-per-order guarantee already -- see that function's own comment).
--    An atomic `times_used = times_used + 1` here (rather than granting the
--    webhook's service-role key a raw UPDATE and having it read-then-write
--    from TypeScript) avoids a race between two orders redeeming the same
--    code at nearly the same moment.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (CREATE OR REPLACE / DROP POLICY IF EXISTS).

-- ============================================================================
-- 1. Admin-only INSERT/UPDATE on promo_codes
-- ============================================================================
drop policy if exists "Admins can insert promo codes" on public.promo_codes;
create policy "Admins can insert promo codes"
  on public.promo_codes
  for insert
  to authenticated
  with check (public.is_admin_user());

drop policy if exists "Admins can update promo codes" on public.promo_codes;
create policy "Admins can update promo codes"
  on public.promo_codes
  for update
  to authenticated
  using (public.is_admin_user())
  with check (public.is_admin_user());

-- Column-scoped -- RLS above is row-level only; these GRANTs are what
-- actually stop an admin session (or a bug in admin.js) from writing to any
-- other column even once the row-level policy allows the row itself.
grant insert (code, discount_percent, active, max_uses, expires_at) on public.promo_codes to authenticated;
grant update (discount_percent, active, max_uses, expires_at) on public.promo_codes to authenticated;

-- ============================================================================
-- 2. Atomic times_used increment (see this migration's own top comment)
-- ============================================================================
create or replace function public.increment_promo_code_usage(p_code text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.promo_codes
  set times_used = times_used + 1
  where code = p_code;
$$;

-- Only stripe-webhook's service-role client ever calls this -- deliberately
-- no anon/authenticated grant (unlike is_admin_user(), which authenticated
-- needs from inside its own RLS policy checks above). A client-callable
-- increment would let anyone bump a code's usage counter without ever
-- actually placing a paid order.
grant execute on function public.increment_promo_code_usage(text) to service_role;
