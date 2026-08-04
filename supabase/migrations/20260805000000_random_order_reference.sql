-- Reference numbers move from the old sequential "EP-2026-0001" format
-- (public.order_reference_seq + generate_order_reference(), added in
-- 20260802000000_add_order_payment_tracking.sql) to a random 8-character
-- alphanumeric code with no prefix -- the sequential format let anyone
-- infer order volume from their own reference number (e.g. "EP-2026-0042"
-- reads as "the 42nd order this year"), which isn't standard practice for a
-- customer-facing order reference.
--
-- Generation itself moves client-side (supabase/functions/stripe-webhook's
-- own generateReferenceCode() + retry-on-conflict loop) instead of a SQL
-- function/sequence -- a random code has no atomic "next value" the way a
-- sequence does, so collision-safety now comes from the UPDATE/INSERT
-- itself failing against the existing `reference_number text unique`
-- constraint (unchanged, still in place -- see that same earlier migration)
-- and the caller retrying with a fresh code, rather than from generation
-- being inherently unique up front. No column/constraint change needed here
-- at all, only cleanup of the now-unused generator.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project. Safe to run more than once (IF EXISTS).

drop function if exists public.generate_order_reference();
drop sequence if exists public.order_reference_seq;
