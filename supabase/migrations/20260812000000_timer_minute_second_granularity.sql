-- Adds minute/second granularity to relative-mode countdowns, on top of
-- 20260810000000_site_config_timer.sql's own relative_duration_hours (kept
-- as-is, unchanged column). admin.html's Timer tab now shows three fields
-- (hours/minutes/seconds) instead of just hours; js/promo-countdown.js sums
-- all three into the same single relative-mode target-time computation it
-- already did with hours alone (see that file's own comment on the one call
-- site this touches).
--
-- relative_duration_hours' own `check (> 0)` from that earlier migration is
-- loosened to `>= 0` here -- a relative duration can now legitimately be
-- "0 hours, 5 minutes" (previously impossible, since hours alone always had
-- to carry the whole duration). The real "duration must add up to something
-- positive" validation moves to admin.js's own save-time check across all
-- three fields together, mirroring how relative_duration_hours' constraint
-- worked alone before this.
--
-- fixed_date mode is completely untouched by this migration -- no column,
-- policy, or grant here affects fixed_end_date or timer_mode at all.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS / CREATE OR
-- REPLACE / GRANT is idempotent).

alter table public.site_config
  add column if not exists relative_duration_minutes integer not null default 0 check (relative_duration_minutes between 0 and 59);

alter table public.site_config
  add column if not exists relative_duration_seconds integer not null default 0 check (relative_duration_seconds between 0 and 59);

alter table public.site_config
  drop constraint if exists site_config_relative_duration_hours_check;

alter table public.site_config
  add constraint site_config_relative_duration_hours_check check (relative_duration_hours >= 0);

-- Column-scoped grant, extended to the two new columns -- same admin-only
-- UPDATE policy from the earlier migration already covers the ROW (RLS is
-- row-level, unaffected by adding columns); this GRANT is what actually lets
-- authenticated write to these two specific new columns at all.
grant update (relative_duration_minutes, relative_duration_seconds) on public.site_config to authenticated;
