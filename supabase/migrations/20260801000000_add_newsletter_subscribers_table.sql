-- Newsletter/email-popup capture, previously mocked entirely in localStorage
-- (js/email-popup.js's now-removed CAPTURED_KEY array, never actually sent
-- anywhere) -- this table is the real backend both the site-wide popup and
-- product.html's newsletter section now insert into, via the shared
-- window.MonarkEmailCapture.captureEmail() (js/email-popup.js).
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for this
-- project. Safe to run more than once (IF NOT EXISTS).

create table if not exists public.newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  subscribed_at timestamptz not null default now(),
  -- Which entry point captured this address -- 'popup' (the site-wide timed
  -- overlay) or 'newsletter_section' (product.html's own inline form), both
  -- via the exact same captureEmail() call. Free text, not an enum -- a
  -- future third entry point shouldn't need a migration just to add another
  -- allowed value.
  source text,
  -- The FR/EN locale active (window.MonarkI18n.getLang()) at the moment of
  -- subscribing, so any future real ESP integration can send the right
  -- language's marketing emails without guessing from the address alone.
  language text
);

alter table public.newsletter_subscribers enable row level security;

-- Anonymous INSERT only -- matches public.orders' own guest-insert policy
-- (see js/account.js's recordOrder(), with_check "user_id IS NULL") and
-- public.promo_codes' own public-read-only policy in spirit: the client can
-- only ever add a new row here, never read, update, or delete any row
-- (including one it just inserted itself). Captured addresses are only ever
-- retrievable via the Supabase Dashboard/SQL Editor.
create policy "Anyone can subscribe to the newsletter"
  on public.newsletter_subscribers
  for insert
  to anon, authenticated
  with check (true);

-- RLS policies alone aren't enough to actually allow the insert -- confirmed
-- the hard way on public.promo_codes (see
-- 20260729120100_grant_promo_codes_select.sql): PostgREST/Postgres still
-- needs the underlying GRANT, which RLS only ever further restricts on top
-- of, never substitutes for.
grant insert on public.newsletter_subscribers to anon, authenticated;

-- No UPDATE policy/grant is defined (deliberately -- the client is INSERT-
-- only per this table's own access model above), so a resubscribe with an
-- already-captured email can't be turned into an UPDATE ... ON CONFLICT from
-- the client side. js/email-popup.js instead just catches the resulting
-- 23505 (unique_violation) error and treats it as a normal successful
-- subscribe from the user's perspective -- see that file's own comment.
