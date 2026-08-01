-- Adds what the new Stripe webhook (supabase/functions/stripe-webhook) needs
-- to be the authoritative source of truth for order completion, instead of
-- the old flow where js/account.js's recordOrder() -- fired client-side,
-- straight after Stripe confirms payment -- was the only thing that ever
-- wrote an order row at all.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for this
-- project. Safe to run more than once (IF NOT EXISTS / CREATE OR REPLACE).

-- Ties an order row to the Stripe PaymentIntent that paid for it -- the one
-- identifier BOTH the client (which already has it, see checkout.html's own
-- stripePaymentIntentId) and the webhook (event.data.object.id) always agree
-- on, so both sides can reconcile onto the exact same row rather than each
-- blindly inserting its own. UNIQUE (not just indexed) is what makes
-- recordOrder()'s client-side insert and the webhook's own insert-or-update
-- safe to race against each other -- whichever side gets there first wins
-- the insert, and the other side's own insert attempt fails with 23505
-- (unique_violation), which both now treat as "already recorded" rather than
-- a real error (see recordOrder()'s own comment, and this webhook's).
alter table public.orders
  add column if not exists payment_intent_id text unique;

-- Short, human-readable reference (e.g. "EP-2026-0001") for order-history
-- displays and the checkout confirmation screen -- a raw uuid isn't
-- something a customer could ever read back over a support email. Only ever
-- assigned by the webhook, once a payment is actually confirmed (see
-- generate_order_reference() below) -- never client-generated, so a
-- guest/authenticated client can't mint its own fake reference number for an
-- order that was never actually paid.
alter table public.orders
  add column if not exists reference_number text unique;

-- status previously defaulted to 'pending' and was, in practice, the only
-- value ever written (see js/account.js's old recordOrder(), which hardcoded
-- it). The new lifecycle: 'processing' (recordOrder()'s own client-side
-- insert, right after Stripe confirms payment in the browser but before the
-- webhook has necessarily landed) -> 'paid' (set by the webhook once
-- payment_intent.succeeded is verified). Left as plain text, not an enum --
-- consistent with public.newsletter_subscribers.source's own "free text over
-- a migration-locked enum" choice elsewhere in this project.

-- Atomic, collision-safe reference-number generation -- nextval() on a
-- sequence is safe under concurrent webhook invocations in a way a
-- "SELECT max(...)+1" pattern never is. Continuously incrementing across
-- years (no per-year reset back to 0001) -- a real per-year reset would need
-- a small counter table keyed by year instead of a plain sequence, which
-- felt like more moving parts than this project's current order volume
-- justifies; EP-2026-0001, EP-2026-0002, ... EP-2027-0001 (wherever the
-- sequence happens to be when the year rolls over) is still short, readable,
-- and strictly ordered, just not reset-to-1-every-January.
create sequence if not exists public.order_reference_seq start with 1;

create or replace function public.generate_order_reference()
returns text
language sql
security definer
set search_path = public
as $$
  select 'EP-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('order_reference_seq')::text, 4, '0');
$$;

-- No new RLS policy/grant is needed for any of this -- the webhook uses the
-- service-role key (bypasses RLS entirely, see that function's own comment),
-- and the existing "Users can view own orders" SELECT policy already covers
-- these two new columns for the client (RLS is row-level, not column-level).
-- Deliberately still no UPDATE policy for anon/authenticated on
-- public.orders -- letting a client update its own order rows would let it
-- rewrite status/total on an order it never actually paid for. That's also
-- exactly why recordOrder() only ever INSERTs (never upserts/updates) and
-- the webhook is the only writer that can ever flip a row to 'paid'.
