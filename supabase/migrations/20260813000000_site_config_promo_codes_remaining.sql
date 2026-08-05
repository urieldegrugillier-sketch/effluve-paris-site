-- Adds a purely cosmetic marketing-urgency counter to site_config, shown on
-- the email-capture popup (js/email-popup.js) as e.g. "Plus que 7 codes
-- promo à ce tarif." -- same pattern as this table's own
-- relative_duration_hours/minutes/seconds: a static, admin-set number, NOT
-- derived from real data. It is deliberately NEVER wired to
-- public.promo_codes.times_used or any checkout/order logic -- an admin
-- changes it by hand, same as they'd change the countdown duration, and it
-- persists until they change it again. See js/promo-countdown.js's own
-- "Fictitious countdown -- purely psychological urgency, not a real
-- deadline" comment for the precedent this follows.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (IF NOT EXISTS / GRANT is idempotent).

alter table public.site_config
  add column if not exists promo_codes_remaining integer not null default 7 check (promo_codes_remaining >= 0);

-- Column-scoped grant, same admin-only UPDATE policy from
-- 20260810000000_site_config_timer.sql already covers the ROW (RLS is
-- row-level, unaffected by adding a column) -- this GRANT is what actually
-- lets authenticated write to this specific new column.
grant update (promo_codes_remaining) on public.site_config to authenticated;
