-- Follow-up to 20260729120000_add_promo_codes_table.sql: the RLS policy
-- alone wasn't enough -- confirmed live, a PostgREST call with the anon key
-- returned 42501 "permission denied for table promo_codes". RLS policies
-- only ever further RESTRICT rows on top of an existing grant; they don't
-- grant table access themselves. Other public-readable tables in this
-- project (e.g. public.products) must have picked up their anon/authenticated
-- SELECT grant some other way (dashboard table creation, or a default
-- privilege set before this project's own migration history started) --
-- this table was created via a raw SQL migration, which doesn't inherit that.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for this
-- project. Safe to run more than once (GRANT is idempotent).

grant select on public.promo_codes to anon, authenticated;
