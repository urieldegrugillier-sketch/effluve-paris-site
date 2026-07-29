-- Moves promo code validation server-side: previously a hardcoded
-- { MONARK10: 0.10 } map baked into js/cart.js (readable/forgeable by anyone
-- with devtools open) and a second, independently-maintained copy in
-- supabase/functions/create-checkout-session/index.ts. This table is the one
-- source of truth both supabase/functions/validate-promo-code (checkout.html's
-- Promo Code field) and create-checkout-session (the actual Stripe charge
-- amount) now read from.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for this
-- project. Safe to run more than once (IF NOT EXISTS / ON CONFLICT DO NOTHING).

create table if not exists public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  discount_percent numeric not null check (discount_percent > 0 and discount_percent <= 100),
  active boolean not null default true,
  -- null = unlimited. times_used is NOT incremented anywhere yet -- there's
  -- no order-completion webhook in this codebase to hook that into safely
  -- (incrementing on mere validation would over-count, since the same code
  -- is re-validated every time the cart changes while Payment is open, see
  -- create-checkout-session's own comment on re-invocation). max_uses is
  -- enforced against whatever times_used holds, but populating it is a
  -- follow-up, not attempted here.
  max_uses integer,
  times_used integer not null default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.promo_codes enable row level security;

-- Public read-only access -- both validate-promo-code and
-- create-checkout-session call this table via the RLS-scoped publishable
-- client (ctx.supabase, no service-role key), the same pattern already used
-- for the public.products row (see create-checkout-session's own comment).
-- No INSERT/UPDATE/DELETE policy is defined, so the table stays read-only to
-- every anon/authenticated caller -- codes are managed exclusively via the
-- Supabase Dashboard / SQL Editor.
create policy "Promo codes are publicly readable"
  on public.promo_codes
  for select
  to anon, authenticated
  using (true);

insert into public.promo_codes (code, discount_percent, active)
values ('MONARK10', 10, true)
on conflict (code) do nothing;
