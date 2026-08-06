-- Atomic stock decrement, called from supabase/functions/stripe-webhook's
-- reconcileOrder() at the exact same three call sites as the existing
-- increment_promo_code_usage() (see that migration's own comment) -- once
-- per order, the FIRST time it turns 'paid'. public.products.stock_remaining
-- is currently only ever moved by hand, via admin.html's Stock tab
-- (20260811000000_admin_stock_edit.sql) -- a real paid order never touched
-- it at all until now.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (CREATE OR REPLACE / GRANT is idempotent).

-- Single UPDATE, no read-then-write -- same race-safety reasoning as
-- increment_promo_code_usage()'s own comment: two orders for the last unit
-- or two units confirming near-simultaneously (two webhook deliveries, or a
-- client-side recordOrder() racing the webhook for two DIFFERENT orders)
-- can't under- or over-decrement each other the way a
-- select-then-subtract-then-update from TypeScript could.
--
-- greatest(0, ...) floors at 0 rather than going negative -- oversold stock
-- (e.g. two orders confirm for a quantity that together exceeds what's
-- actually left, since nothing today re-checks stock at charge time) is
-- surfaced as "stuck at 0", not a confusing negative number on admin.html's
-- own Stock tab. This migration deliberately does NOT add any check that
-- BLOCKS a checkout/charge once stock hits 0 -- that's a separate product
-- decision (does "sold out" stop new orders, or just stop advertising
-- availability?) left for a follow-up once confirmed, not assumed here.
--
-- No product id parameter -- same simplification already used throughout
-- this codebase (create-checkout-session's own price lookup, product.html's
-- own stock read) for "this project's one current MONARK edition": there's
-- only ever one row, and public.orders itself has no product_id column to
-- pass through anyway (only product_name, a plain text snapshot). The
-- `where id = (select id from public.products limit 1)` subquery -- rather
-- than an unqualified UPDATE with no WHERE at all, which would have the
-- exact same effect today but reads as a mistake to a future maintainer --
-- targets that one row explicitly without hardcoding its id, and stays
-- correct without changes if a second product row is ever added and this
-- function just hasn't been revisited yet (it would keep updating only the
-- first row, not silently touch every product).
--
-- Returns the resulting stock_remaining -- not used for any decision here,
-- purely so the Edge Function's own logging can show the real number
-- (matches this project's general "log enough to actually notice a problem"
-- convention), same as this migration's own worked example in
-- supabase/functions/stripe-webhook.
create or replace function public.decrement_product_stock(p_quantity integer)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.products
  set stock_remaining = greatest(0, stock_remaining - p_quantity)
  where id = (select id from public.products limit 1)
  returning stock_remaining;
$$;

-- Only stripe-webhook's service-role client ever calls this -- same
-- reasoning as increment_promo_code_usage()'s own grant: a client-callable
-- decrement would let anyone drain the displayed stock count without ever
-- placing a real paid order.
grant execute on function public.decrement_product_stock(integer) to service_role;

-- service_role's own SELECT on public.products already works today
-- (stripe-webhook's existing computePriceBreakdown() already reads
-- products.price successfully via the service-role client) -- but UPDATE is
-- a separate privilege, and every other table in this project's history
-- needed its own explicit service_role grant added on top of RLS bypass
-- (profiles, orders, promo_codes -- see each of those migrations' own
-- comments on the exact same gap). Granting it here rather than assuming
-- RLS bypass alone covers it, which it doesn't -- GRANTs and RLS are
-- separate mechanisms (RLS-bypass only skips ROW-level policy checks, the
-- underlying table-level GRANT still has to exist on top of that).
grant update (stock_remaining) on public.products to service_role;
