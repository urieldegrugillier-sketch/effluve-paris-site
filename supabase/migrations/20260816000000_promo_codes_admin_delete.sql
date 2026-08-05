-- Admin-only DELETE on public.promo_codes, backing admin.html's new
-- "Supprimer" button on the Promo Codes tab. Same is_admin_user()-gated
-- pattern as every other admin-write policy in this project.
--
-- site_config.promo_remaining_code_id's own FK to this table (see
-- 20260815000000_site_config_promo_remaining_code_selectable.sql) has no
-- ON DELETE clause, i.e. Postgres' default NO ACTION -- deleting a code
-- that column currently points at already fails at the DB level with a
-- foreign-key violation, before this policy is even relevant. admin.js
-- pre-checks for that case client-side and blocks with a friendly message
-- rather than surfacing the raw constraint error, but this migration
-- deliberately does not change the FK's ON DELETE behavior itself -- that
-- protection (never silently orphaning/nulling the counter's own selection
-- by deleting out from under it) is intentional, see this feature's own
-- admin.js comment on why blocking beats auto-clearing here.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (DROP POLICY IF EXISTS / GRANT is idempotent).

drop policy if exists "Admins can delete promo codes" on public.promo_codes;
create policy "Admins can delete promo codes"
  on public.promo_codes
  for delete
  to authenticated
  using (public.is_admin_user());

-- No column-scoping applies to DELETE (unlike the INSERT/UPDATE grants this
-- table already has) -- a row is either deletable or it isn't.
grant delete on public.promo_codes to authenticated;
