-- Supports the new shipping-notification / re-shipment-correction emails
-- (supabase/functions/mark-order-shipped), sent when an admin marks an
-- order shipped or corrects its tracking number via admin.html.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (IF NOT EXISTS).

-- Same email_sent pattern as the order-confirmation email
-- (20260802000000_add_order_payment_tracking.sql's own follow-up,
-- 20260803000000_add_order_email_sent.sql) -- defaults false, only ever
-- flipped true after a confirmed Resend accept, so a stuck false on a
-- 'shipped' order is exactly what to look for if a shipping email silently
-- failed to send.
alter table public.orders
  add column if not exists shipping_email_sent boolean not null default false;

-- The order-confirmation email's language came from the PaymentIntent's own
-- metadata (ephemeral, gone once Stripe's own retention window passes) --
-- fine for that email, sent synchronously off the same webhook call that
-- already has that metadata in hand. The shipping email is sent much later,
-- from an admin action with no metadata to read at all, so the language
-- needs to actually persist on the row itself this time (unlike e.g. the
-- shipping address, deliberately kept out of this table -- see
-- supabase/functions/stripe-webhook's own comment on why that one stays
-- metadata-only). Nullable + no default: existing orders predating this
-- column fall back to French (js/i18n.js's own DEFAULT_LANG) at the
-- application layer, same fallback the confirmation email's own language
-- resolution already uses.
alter table public.orders
  add column if not exists language text;
