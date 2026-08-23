-- Free-text carrier name for the "Autre" (Other) option in admin.html's
-- mark-as-shipped carrier <select> -- until now, picking "Autre" recorded
-- nothing beyond the literal string "autre" on the order, and the shipping
-- email had no way to say WHICH carrier was actually used (it already
-- correctly never built a tracking link for this case -- see
-- carrierTrackingUrl()'s own default branch in supabase/functions/
-- mark-order-shipped -- but the email said nothing else about the carrier
-- either). This column is admin-typed free text ("Mode de transport : ...")
-- shown in place of a link for exactly that case.
--
-- Nullable, no default, no CHECK -- only ever meaningful when carrier =
-- 'autre' (public.orders.carrier's own CHECK constraint, unchanged); NULL
-- for every other carrier and for every order that predates this column,
-- same "nothing to backfill, absence just means absence" reasoning as
-- carrier itself (20260821000000_order_shipping_address_and_carrier.sql).
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (IF NOT EXISTS).

alter table public.orders
  add column if not exists carrier_other_name text;

-- Same defense-in-depth backstop grant as carrier itself
-- (20260821000000_order_shipping_address_and_carrier.sql's own comment) --
-- admin.html's real write path is supabase/functions/mark-order-shipped
-- (service-role, unaffected by this), this only extends the RLS-gated
-- direct-from-browser fallback to cover the one new column that same admin
-- action now also writes.
grant update (carrier_other_name) on public.orders to authenticated;
