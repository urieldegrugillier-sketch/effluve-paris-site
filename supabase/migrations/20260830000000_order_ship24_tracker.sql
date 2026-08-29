-- Ship24 tracker correlation ID -- supabase/functions/mark-order-shipped
-- creates a Ship24 tracker (POST /public/v1/trackers/track) right after
-- marking an order shipped, and stores the trackerId Ship24 returns here.
-- supabase/functions/ship24-webhook is the only reader: an incoming webhook
-- carries Ship24's own trackerId, not this project's order id, so this
-- column is what maps one back to the other.
--
-- Nullable, no default -- same "absence just means absence" reasoning as
-- carrier/shipped_at before it. An order can legitimately have no tracker:
-- Ship24 tracker creation is best-effort (network/quota failures never
-- block marking an order shipped, see mark-order-shipped's own comment),
-- and orders shipped before this feature existed never got one either.
--
-- No grant to `authenticated` (unlike shipped_at/carrier/tracking_number) --
-- this column has no legitimate direct-from-browser writer, planned or
-- otherwise. Its only writer is mark-order-shipped's own service-role
-- client; its only external reader is Ship24 (indirectly, via the
-- trackerId it echoes back in webhooks) and ship24-webhook's own
-- service-role client, neither of which needs or goes through RLS.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (IF NOT EXISTS).

alter table public.orders
  add column if not exists ship24_tracker_id text;

-- Every lookup ship24-webhook does is "find the order for this trackerId" --
-- this is what keeps that a fast index lookup instead of a sequential scan
-- as the orders table grows. Partial (where not null) since the vast
-- majority of rows will never have one (orders predating this feature,
-- unshipped orders, and any order whose Ship24 tracker creation failed) --
-- indexing those would just be dead weight.
create index if not exists idx_orders_ship24_tracker_id
  on public.orders (ship24_tracker_id)
  where ship24_tracker_id is not null;
