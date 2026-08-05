-- Admin-only write access to public.products' two stock columns, backing
-- admin.html's new "Stock" tab. Same is_admin_user()-gated pattern as every
-- other admin-write policy in this project (orders' shipping fields,
-- promo_codes, site_config).
--
-- public.products itself (like public.orders/public.profiles) was created
-- outside this migration history, with its own public SELECT policy/grant
-- already in place -- confirmed working today (product.html's own live
-- stock_remaining/stock_total read, create-checkout-session's own price
-- read). Nothing about that read path is touched here; this only adds the
-- admin write path that didn't exist yet.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (DROP POLICY IF EXISTS / GRANT is idempotent).

drop policy if exists "Admins can update stock" on public.products;
create policy "Admins can update stock"
  on public.products
  for update
  to authenticated
  using (public.is_admin_user())
  with check (public.is_admin_user());

-- Column-scoped -- same reasoning as every other admin-write grant in this
-- project: an admin editing stock can only ever touch stock_remaining/
-- stock_total, never price/original_price/name (a client rewriting its own
-- charge amount is exactly the risk 20260802000000_add_order_payment_tracking.sql's
-- own comment already flagged for orders; the same boundary applies here).
grant update (stock_remaining, stock_total) on public.products to authenticated;
