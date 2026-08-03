-- Adds what the order-confirmation email (supabase/functions/stripe-webhook,
-- via Resend) needs to make send failures visible instead of silent -- see
-- that function's own sendConfirmationEmail() comment for why a failed send
-- must never block/rollback the 'paid' status update it happens after.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for this
-- project, same as the two migrations before it. Safe to run more than once
-- (IF NOT EXISTS).

-- Defaults false and is only ever flipped to true after a confirmed 2xx from
-- Resend -- so `false` covers both "not attempted yet" (order still
-- 'processing') and "attempted and failed", which is exactly the set of rows
-- worth a manual look/resend. No retry queue/cron on top of this -- at this
-- project's current order volume, a `select * from orders where status =
-- 'paid' and email_sent = false` in the SQL Editor is enough to catch
-- failures; revisit if volume ever makes that manual check impractical.
alter table public.orders
  add column if not exists email_sent boolean not null default false;

-- No RLS/grant change needed -- same reasoning as
-- 20260802000000_add_order_payment_tracking.sql's own note: the webhook
-- writes this via the service-role client (bypasses RLS), and the existing
-- "Users can view own orders" SELECT policy already covers this new column
-- for the client (RLS is row-level, not column-level). Still no client-side
-- UPDATE policy, so a customer can never self-flag their own order as
-- email-sent either.
