-- Two additions, both to public.orders:
--
-- 1. shipped_at -- until now, shipping_status flipping to 'shipped'
--    (supabase/functions/mark-order-shipped) recorded THAT it shipped but
--    never WHEN. account.html's Order History can't show a "Shipped on
--    [date]" line without a real timestamp to read -- confirmed by reading
--    every column on this table plus every write to it: nothing already
--    captures this, despite created_at existing for the order itself.
--    Nullable, no default -- same "absence just means absence, no
--    backfill" reasoning as carrier/carrier_other_name before it
--    (20260821000000_order_shipping_address_and_carrier.sql,
--    20260823000000_order_carrier_other_name.sql): an order already shipped
--    before this column existed has no real ship date to backfill from and
--    simply won't show the new line, same as it never showed a carrier link
--    for orders that predated that column.
--
-- 2. delivered_at -- SCAFFOLDING ONLY for a planned automated
--    delivery-detection feature (poll Colissimo/Mondial Relay's own
--    tracking APIs, set this once a shipment is confirmed delivered, send a
--    "delivered" confirmation email). Column added now so the schema is
--    ready; NOT yet written by anything (see
--    supabase/functions/check-delivery-status's own placeholder structure)
--    -- both carriers' OFFICIAL tracking APIs require a registered
--    professional account (Colissimo's Coliship requires a SIRET even for a
--    test account; Mondial Relay's own webservice credentials require a Pro
--    merchant account) that this project doesn't have yet. Deliberately NO
--    grant/RLS policy extended for this column (unlike shipped_at below) --
--    there's no legitimate direct-from-browser writer for it, planned or
--    otherwise; its only intended writer is that future function's own
--    service-role client.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (IF NOT EXISTS).

alter table public.orders
  add column if not exists shipped_at timestamptz,
  add column if not exists delivered_at timestamptz;

-- Same defense-in-depth backstop as shipping_status/tracking_number/carrier
-- before it (20260806000000_admin_shipping.sql, 20260821000000_order_
-- shipping_address_and_carrier.sql) -- admin.html's real write path is
-- supabase/functions/mark-order-shipped (service-role, unaffected by this),
-- this only extends the RLS-gated direct-from-browser fallback to cover the
-- one new column that same admin action now also writes. The existing
-- "Admins can update shipping fields" policy (20260806000000_admin_
-- shipping.sql) already covers row-level access for this update -- only the
-- column-level grant needs extending here, not the policy itself.
grant update (shipped_at) on public.orders to authenticated;
