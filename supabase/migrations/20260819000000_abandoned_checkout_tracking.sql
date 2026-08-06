-- Abandoned-cart tracking: backs the new two-stage reminder email system
-- (supabase/functions/send-abandoned-cart-reminders, scheduled by
-- 20260819000100_schedule_abandoned_cart_reminders.sql). Nothing in this
-- codebase persisted an "in-progress checkout" anywhere before this --
-- public.orders only ever gets a row once payment has already succeeded
-- (js/account.js's recordOrder(), fired client-side right after Stripe
-- confirms payment) or via supabase/functions/stripe-webhook's own
-- payment_intent.succeeded handler. There was no data model for "someone
-- started checking out and stopped" to detect abandonment from -- this
-- migration adds exactly that, and only that.
--
-- One row per checkout ATTEMPT, covering both cases the reminder system
-- needs to catch:
--   (a) email entered at the Account step, checkout never finished -- the
--       row is created here, at that step, since nothing else in this
--       codebase ever captures that moment today.
--   (b) a Stripe PaymentIntent was created (checkout.html's Payment step,
--       via create-checkout-session) but never reached 'paid' -- the SAME
--       row gets its payment_intent_id filled in once that step is reached,
--       rather than creating a second, disconnected record. In this
--       project's actual Stripe integration there's no separate "Checkout
--       Session" object at all (create-checkout-session builds a raw
--       PaymentIntent directly, see that function's own header comment) --
--       the PaymentIntent IS the closest equivalent, and its id is exactly
--       what already lets public.orders/stripe-webhook reconcile onto one
--       row instead of racing duplicates (see that migration's own
--       payment_intent_id comment) -- reused here for the same reason.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE / DROP
-- POLICY IF EXISTS).

create table if not exists public.abandoned_checkouts (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  -- Logged-in session's auth uid, when known -- same "client-supplied, same
  -- trust level as guest_email" reasoning as create-checkout-session's own
  -- userId (see that function's own comment): there's no server-verified
  -- identity to derive this from independently at either call site, and
  -- none is needed -- this is only ever used to help mark_converted_
  -- abandoned_checkouts() match against public.orders.user_id, never to
  -- authorize anything.
  user_id uuid,
  language text not null default 'fr' check (language in ('fr', 'en')),
  -- Set once the Payment step is reached (case (b) above); null for a
  -- checkout that never got that far (case (a) only). UNIQUE mirrors
  -- public.orders.payment_intent_id's own constraint (multiple NULLs are
  -- fine under Postgres unique constraints) -- a PaymentIntent belongs to at
  -- most one tracked attempt.
  payment_intent_id text unique,
  -- First time this attempt was seen (Account step resolved, or a brand new
  -- attempt created because no still-open one existed -- see
  -- track_abandoned_checkout() below).
  created_at timestamptz not null default now(),
  -- Bumped on every re-entry into an already-open attempt (re-resolving the
  -- Account step, reaching/re-reaching Payment) -- both reminder stages are
  -- timed from THIS, not created_at, so someone actively still working
  -- through checkout doesn't get a reminder mid-attempt just because they
  -- started it over an hour ago.
  last_activity_at timestamptz not null default now(),
  reminder_1_sent_at timestamptz,
  reminder_2_sent_at timestamptz,
  -- The per-customer promo_codes.code minted for this attempt's stage-2
  -- incentive (see that migration's own comment on why per-customer, not a
  -- single shared code) -- null until stage 2 actually sends.
  discount_code text,
  -- Stamped by mark_converted_abandoned_checkouts() once a matching PAID
  -- order is found -- never set by the client, and never inferred from
  -- client-side "purchase complete" behavior (a closed tab/dropped network
  -- right after payment must never cause a reminder to fire for an order
  -- that actually went through -- same failure mode stripe-webhook's own
  -- header comment describes for the confirmation email, solved the same
  -- way: trust the server-side record, not the browser).
  converted_at timestamptz
);

-- Speeds up both the mark_converted_abandoned_checkouts() sweep and the
-- reminder function's own stage-1/stage-2 candidate queries, which always
-- filter on "still open" (converted_at is null) ordered/filtered by
-- last_activity_at -- a partial index only over the rows that matter (most
-- rows settle into "converted" or "fully reminded" within hours and are
-- never queried this way again).
create index if not exists idx_abandoned_checkouts_open
  on public.abandoned_checkouts (last_activity_at)
  where converted_at is null;

alter table public.abandoned_checkouts enable row level security;

-- RLS enabled with zero policies, and no GRANTs to anon/authenticated below
-- -- same lockdown pattern as public.check_email_rate_limits (see
-- 20260817000000_check_email_rate_limit.sql's own comment). Nothing ever
-- reads or writes this table directly from the client: both checkout.html
-- call sites go through track_abandoned_checkout() (SECURITY DEFINER,
-- granted to anon/authenticated below) instead of a raw table insert/
-- update, and the reminder function itself uses the service-role key.
--
-- ============================================================================
-- track_abandoned_checkout() -- called from TWO places:
--   1. js/checkout-page.js, right when the Account step's gate resolves
--      (case (a) -- email known, no payment_intent_id yet).
--   2. supabase/functions/create-checkout-session, right after it creates/
--      updates the PaymentIntent for this checkout (case (b) -- same email,
--      now with a payment_intent_id to attach).
-- Both call sites already have the identity (email/userId) in hand
-- client-side or from the request body -- same trust level as
-- create-checkout-session's own guestEmail/userId/customerEmail (see that
-- function's own comment), passed explicitly rather than derived from
-- auth.uid(), which would silently be null for an anonymous/guest caller
-- anyway and isn't reliably forwarded through ctx.supabase either way.
-- ============================================================================
create or replace function public.track_abandoned_checkout(
  p_email text,
  p_language text,
  p_user_id uuid default null,
  p_payment_intent_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open_id uuid;
begin
  if p_email is null or btrim(p_email) = '' then
    return;
  end if;

  -- "Open" = not yet converted, not yet fully reminded-out (both stages
  -- already sent), and started recently enough (24h) that this is still
  -- plausibly the SAME checkout attempt, not a genuinely new visit days
  -- later -- which should start its own fresh reminder cycle rather than
  -- silently re-extending a stale one that already ran its course.
  select id into v_open_id
  from public.abandoned_checkouts
  where lower(email) = lower(btrim(p_email))
    and converted_at is null
    and reminder_2_sent_at is null
    and created_at > now() - interval '24 hours'
  order by created_at desc
  limit 1;

  if v_open_id is not null then
    update public.abandoned_checkouts
    set last_activity_at = now(),
        user_id = coalesce(p_user_id, user_id),
        payment_intent_id = coalesce(p_payment_intent_id, payment_intent_id),
        language = coalesce(nullif(p_language, ''), language)
    where id = v_open_id;
  else
    insert into public.abandoned_checkouts (email, user_id, language, payment_intent_id)
    values (lower(btrim(p_email)), p_user_id, coalesce(nullif(p_language, ''), 'fr'), p_payment_intent_id);
  end if;
end;
$$;

grant execute on function public.track_abandoned_checkout(text, text, uuid, text) to anon, authenticated;

-- ============================================================================
-- mark_converted_abandoned_checkouts() -- run first thing on every
-- send-abandoned-cart-reminders invocation, before either stage's candidate
-- query. A row counts as converted the moment a PAID order exists that's
-- plausibly the SAME purchase: an exact payment_intent_id match (precise --
-- only possible once case (b)'s hook has run), OR the same logged-in user_id,
-- OR a matching guest_email -- either of the latter two also catches case
-- (a)-only rows (abandoned before ever reaching Payment, so no
-- payment_intent_id to match on) that the customer nonetheless went on to
-- complete, possibly in an entirely later, separate attempt. `o.created_at
-- >= abandoned_checkouts.created_at` guards against matching a PAST order
-- that predates this abandoned attempt (e.g. a repeat customer whose email
-- already has old paid orders on file) -- only a purchase that happened
-- AFTER this attempt started can be what it converted into.
-- ============================================================================
create or replace function public.mark_converted_abandoned_checkouts()
returns void
language sql
security definer
set search_path = public
as $$
  update public.abandoned_checkouts ac
  set converted_at = now()
  where ac.converted_at is null
    and exists (
      select 1
      from public.orders o
      where o.status = 'paid'
        and o.created_at >= ac.created_at
        and (
          (ac.payment_intent_id is not null and o.payment_intent_id = ac.payment_intent_id)
          or (ac.user_id is not null and o.user_id = ac.user_id)
          or (o.guest_email is not null and lower(o.guest_email) = lower(ac.email))
        )
    );
$$;

grant execute on function public.mark_converted_abandoned_checkouts() to service_role;

-- The reminder function reads/updates this table directly (stage-1/stage-2
-- candidate queries, stamping reminder_1_sent_at/reminder_2_sent_at/
-- discount_code) using the service-role key -- same "service_role needs its
-- own explicit grant, RLS bypass alone doesn't substitute for it" lesson
-- already learned once for public.profiles (see
-- 20260808000000_grant_profiles_service_role.sql).
grant select, insert, update on public.abandoned_checkouts to service_role;

-- Same lesson again: service_role only ever got SELECT on public.promo_codes
-- (see 20260804000000_grant_promo_codes_service_role.sql's own comment on
-- why) -- send-abandoned-cart-reminders' stage 2 needs INSERT too, to mint
-- each customer's own one-time discount code there. Column-scoped, matching
-- the exact same column set already granted to authenticated for admin.html's
-- own promo-code creation (20260809000000_promo_codes_admin_and_usage_tracking.sql)
-- -- this function never touches times_used (only
-- increment_promo_code_usage() does) or id/created_at either.
grant insert (code, discount_percent, active, max_uses, expires_at) on public.promo_codes to service_role;
