-- Dual-modes the "codes remaining" urgency line (js/email-popup.js):
--   'fixed' -- unchanged behavior, the static admin-set
--             site_config.promo_codes_remaining number (see that column's
--             own migration comment).
--   'real'  -- the popup instead computes the count live as
--             public.promo_codes.max_uses - times_used for MONARK10 (the
--             only code that exists). Still read client-side, still no
--             wiring into checkout/order logic -- this only changes WHERE
--             the displayed number comes from, not how it's used.
--
-- admin.html's Promo Codes tab is what edits this now (moved off the Timer
-- tab, which only ever kept the flat number) -- it blocks switching to
-- 'real' client-side unless MONARK10's max_uses is already set, but that's
-- a UX guard, not enforced here at the DB level (max_uses staying nullable
-- is unaffected by this migration; a null max_uses in 'real' mode is simply
-- a case the popup's own fetch logic decides how to handle, see that file's
-- own comment).
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (IF NOT EXISTS / GRANT is idempotent).

alter table public.site_config
  add column if not exists promo_remaining_mode text not null default 'fixed' check (promo_remaining_mode in ('fixed', 'real'));

-- Column-scoped grant, same admin-only UPDATE policy from
-- 20260810000000_site_config_timer.sql already covers the ROW.
grant update (promo_remaining_mode) on public.site_config to authenticated;
