-- Same class of gap as 20260802000100_grant_orders_service_role.sql, this
-- time on public.promo_codes: supabase/functions/stripe-webhook's
-- computePriceBreakdown() (service-role client) needs to read
-- discount_percent to build the confirmation email's price breakdown, but
-- got 42501 "permission denied for table promo_codes" the same way that
-- earlier migration's own orders SELECT did. RLS bypass (service_role's
-- usual privilege) is a separate mechanism from the underlying Postgres
-- table GRANTs -- this table was created outside this migration history
-- (like public.orders/public.profiles/public.products), so service_role
-- apparently never actually got granted access, only anon/authenticated did
-- (see validate-promo-code/create-checkout-session, both of which already
-- read this table fine via the publishable-key-scoped ctx.supabase client).
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project. Safe to run more than once (GRANT is idempotent).

grant select on public.promo_codes to service_role;
