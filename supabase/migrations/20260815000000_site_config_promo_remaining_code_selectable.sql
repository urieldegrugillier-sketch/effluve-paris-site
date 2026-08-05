-- Makes the "codes remaining" urgency line's 'real'-mode target code
-- selectable instead of hardcoded to MONARK10 (see
-- 20260814000000_site_config_promo_remaining_mode.sql's own comment on that
-- mode). admin.html's Promo Codes tab settings block now has a dropdown of
-- every existing promo_codes row; this column remembers which one was
-- picked. js/email-popup.js's own 'real'-mode computation reads this column
-- instead of a hardcoded code string.
--
-- Nullable -- a fresh install (or a site_config row that predates this
-- migration) has nothing selected yet; admin.html's own load logic falls
-- back to the oldest existing code in that case (see that file's own
-- comment), and js/email-popup.js treats a null the same as any other
-- "can't compute a real count" case (hide the line -- see that file's own
-- comment on promoCodesRemainingHidden).
--
-- No ON DELETE behavior specified beyond Postgres' own default (NO ACTION)
-- -- deleting a promo_codes row this column points at isn't a flow this
-- admin tool offers today (codes are only ever created/edited, never
-- deleted, see the Promo Codes tab's own modal), so there's nothing to
-- design around yet.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (IF NOT EXISTS / GRANT is idempotent).

alter table public.site_config
  add column if not exists promo_remaining_code_id uuid references public.promo_codes(id);

-- Column-scoped grant, same admin-only UPDATE policy from
-- 20260810000000_site_config_timer.sql already covers the ROW.
grant update (promo_remaining_code_id) on public.site_config to authenticated;
