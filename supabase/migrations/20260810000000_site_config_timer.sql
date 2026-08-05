-- New single-row config table backing admin.html's "Minuteur" tab, replacing
-- js/promo-countdown.js's own hardcoded COUNTDOWN_START_SECONDS constant
-- (3h52m16s, reset on every page load, no persistence -- see that file's own
-- comment) with an admin-editable value read from Supabase on page load.
--
-- Two modes (timer_mode):
--   'relative'   -- same behavior as today: every visitor's own page load
--                   starts a fresh countdown, relative_duration_hours long.
--   'fixed_date' -- countdown runs down to fixed_end_date, identical for
--                   every visitor, does not reset on refresh. If that date
--                   has already passed, the front end hides the countdown
--                   entirely (banner + product.html + checkout.html
--                   displays) rather than showing a static "offer ended"
--                   state -- a deliberate product decision, not a gap.
--
-- relative_duration_hours is whole hours (int), not the old H:M:S precision
-- -- an admin-facing "duration in hours" field is simpler than exposing
-- seconds, and this feature has never claimed second-level precision matters
-- (the old constant was itself an arbitrary "looks urgent" number, see that
-- file's own "Fictitious countdown -- purely psychological urgency" comment).
--
-- Single row, no enforced singleton constraint -- same "there's only ever
-- one" convention as public.products (read via .limit(1).maybeSingle()
-- everywhere it's queried, see create-checkout-session/stripe-webhook's own
-- product lookups). Seeded below with the closest whole-hour equivalent of
-- the old constant (4h) so nothing changes in effect the moment this ships.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (CREATE OR REPLACE / DROP POLICY IF EXISTS / the
-- guarded INSERT below).

create table if not exists public.site_config (
  id uuid primary key default gen_random_uuid(),
  timer_mode text not null default 'relative' check (timer_mode in ('relative', 'fixed_date')),
  relative_duration_hours integer not null default 4 check (relative_duration_hours > 0),
  fixed_end_date timestamptz,
  created_at timestamptz not null default now()
);

alter table public.site_config enable row level security;

-- Public read -- every page (not just admin.html) reads this on load to
-- drive the countdown, including anonymous/guest visitors. Same
-- policy-plus-explicit-grant pairing public.promo_codes needed (RLS alone
-- doesn't grant table access -- see 20260729120100_grant_promo_codes_select.sql's
-- own comment on why, confirmed live for that table; applied proactively
-- here rather than waiting to hit the same 42501 in production).
create policy "Site config is publicly readable"
  on public.site_config
  for select
  to anon, authenticated
  using (true);

grant select on public.site_config to anon, authenticated;

-- Admin-only UPDATE, same is_admin_user()-gated pattern as
-- 20260806000100_fix_admin_rls_recursion.sql / this project's promo_codes
-- admin policies. No INSERT policy -- the seed row below is the only row
-- this table is ever meant to have; admin.html's Timer tab only ever
-- UPDATEs it, never creates a new one (unlike the Promo Codes tab, which
-- genuinely needs to create new rows).
drop policy if exists "Admins can update site config" on public.site_config;
create policy "Admins can update site config"
  on public.site_config
  for update
  to authenticated
  using (public.is_admin_user())
  with check (public.is_admin_user());

-- Column-scoped, same reasoning as every other admin-write grant in this
-- project -- id/created_at are never meant to change after the row exists.
grant update (timer_mode, relative_duration_hours, fixed_end_date) on public.site_config to authenticated;

-- Guarded (not a plain INSERT) so re-running this migration never adds a
-- second row -- site_config has no natural unique column an ON CONFLICT
-- target could use, so "insert if empty" is the safe idempotent check here.
insert into public.site_config (timer_mode, relative_duration_hours, fixed_end_date)
select 'relative', 4, null
where not exists (select 1 from public.site_config);
