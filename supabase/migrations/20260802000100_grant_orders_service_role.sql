-- Follow-up to 20260802000000_add_order_payment_tracking.sql -- same lesson
-- as 20260729120100_grant_promo_codes_select.sql, this time hitting
-- service_role instead of anon: confirmed live, supabase/functions/
-- stripe-webhook's service-role client got 42501 "permission denied for
-- table orders" on a plain SELECT. service_role bypasses RLS entirely, but
-- that's a separate mechanism from the underlying Postgres table
-- GRANTs -- RLS bypass doesn't imply SELECT/INSERT/UPDATE were ever
-- actually granted, and for this table (created outside this migration
-- history, like public.profiles/public.products) they apparently never
-- were for service_role specifically, only for anon/authenticated.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project. Safe to run more than once (GRANT is idempotent).

grant select, insert, update on public.orders to service_role;
