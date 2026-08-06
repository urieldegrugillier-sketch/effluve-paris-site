-- Two additions, bundled since both back the same admin.html Orders-tab
-- change (reveal-gated shipping info + a carrier selector when marking an
-- order shipped):
--
-- 1. Shipping address columns on public.orders -- this table has NEVER
--    stored the shipping address at all. It only ever existed briefly, on
--    the Stripe PaymentIntent's own metadata (create-checkout-session sets
--    it, see that function's own comment), read ONCE by
--    supabase/functions/stripe-webhook to print the confirmation email's
--    address recap, then gone (metadata isn't queried again after that).
--    admin.html's Orders tab has accordingly never had any address to show
--    -- confirmed by reading every line of admin.html/js/admin.js, not
--    assumed. Persisting it here is what makes "reveal shipping info before
--    the tracking field" mean anything real, matching the exact same
--    fields already sent in create-checkout-session's own metadata
--    (shipping_name/shipping_address_line1/shipping_address_line2/
--    shipping_city/shipping_postal_code/shipping_country).
--
-- 2. carrier -- which courier a shipped order actually went with
--    (Colissimo/Chronopost/Mondial Relay/Autre), set alongside
--    tracking_number in the same admin.html "mark as shipped" action. Lets
--    supabase/functions/mark-order-shipped build the correct carrier's
--    tracking-page link instead of a bare, unlinked number. Nullable, no
--    default -- same reasoning as this table's own `language` column
--    (20260807000000_shipping_email.sql): existing already-shipped orders
--    predate this and simply show the tracking number as plain text (no
--    carrier to build a link from), never a guessed one.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (IF NOT EXISTS).

alter table public.orders
  add column if not exists shipping_name text,
  add column if not exists shipping_address_line1 text,
  add column if not exists shipping_address_line2 text,
  add column if not exists shipping_city text,
  add column if not exists shipping_postal_code text,
  add column if not exists shipping_country text;

alter table public.orders
  add column if not exists carrier text
    check (carrier is null or carrier in ('colissimo', 'chronopost', 'mondial_relay', 'autre'));

-- No new grant needed for the shipping_address_* columns or for reading
-- carrier: stripe-webhook writes the address via its existing service-role
-- client (already granted select/insert/update/delete on this table, see
-- 20260802000100_grant_orders_service_role.sql), and admin.html only ever
-- READS them -- RLS is row-level, not column-level, so the existing "Admins
-- can view all orders" policy (20260806000000_admin_shipping.sql) already
-- covers any column on a row it allows at all, same as every other column
-- added to this table since that policy shipped.
--
-- carrier's WRITE path is different: admin.html's actual "mark as shipped"
-- action always goes through supabase/functions/mark-order-shipped
-- (service-role, unaffected by this), but that function's own header
-- comment notes the row UPDATE could also happen directly from the browser
-- via RLS, kept as a defense-in-depth backstop -- and THAT backstop's own
-- grant is column-scoped to exactly `shipping_status, tracking_number`
-- (20260806000000_admin_shipping.sql), the columns admin.html's mark-as-
-- shipped action writes. carrier is now written by that exact same action,
-- so it's added to the same backstop grant for the same reason -- not
-- extended to the shipping_address_* columns, which no admin action ever
-- writes at all (stripe-webhook, service-role, is their only writer).
grant update (carrier) on public.orders to authenticated;
