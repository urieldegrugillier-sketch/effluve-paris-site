-- Data the abandoned-cart reminder emails need (see
-- supabase/functions/send-abandoned-cart-reminders/email.ts):
--
-- 1. public.abandoned_checkouts.quantity: how many units were in the cart,
--    so the reminders can show quantity, unit price and line total. Carts
--    only live in the browser's localStorage, so nothing server-side knew
--    this before. Written by track_abandoned_checkout() from both call
--    sites: js/checkout-page.js (Account step, cart quantity) and
--    create-checkout-session (Payment step, the server-clamped quantity that
--    is actually charged). Null on older rows; the reminders treat null as 1.
--
-- 2. public.products.original_price: the site's struck-through reference
--    price (currently 189, the same figure as js/cart.js PRODUCT.originalPrice
--    and product.html's .shop-price-original). The second reminder computes
--    "X EUR off your fragrance" from price and original_price on this same
--    row, so both values come from the database rather than being hardcoded
--    in the edge function. If the reference price changes, update it here
--    (Table editor or SQL), in js/cart.js and in product.html.

alter table public.abandoned_checkouts
  add column if not exists quantity integer
    check (quantity is null or quantity between 1 and 50);

-- Adding a parameter changes the function signature, so the old 4-argument
-- version has to be dropped first. Otherwise both overloads would exist and
-- PostgREST calls with named arguments would become ambiguous.
drop function if exists public.track_abandoned_checkout(text, text, uuid, text);

create or replace function public.track_abandoned_checkout(
  p_email text,
  p_language text,
  p_user_id uuid default null,
  p_payment_intent_id text default null,
  p_quantity integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open_id uuid;
  -- Same 1..50 bound create-checkout-session applies to the charged
  -- quantity; anything else (null, garbage) is ignored, never stored.
  v_quantity integer := case when p_quantity between 1 and 50 then p_quantity else null end;
begin
  if p_email is null or btrim(p_email) = '' then
    return;
  end if;

  -- Same "open attempt" definition as the original version of this function
  -- (20260819000000_abandoned_checkout_tracking.sql).
  select id into v_open_id
  from public.abandoned_checkouts
  where lower(email) = lower(btrim(p_email))
    and converted_at is null
    and reminder_2_sent_at is null
    and created_at > now() - interval '24 hours'
  order by created_at desc
  limit 1;

  if v_open_id is not null then
    update public.abandoned_checkouts
    set last_activity_at = now(),
        user_id = coalesce(p_user_id, user_id),
        payment_intent_id = coalesce(p_payment_intent_id, payment_intent_id),
        language = coalesce(nullif(p_language, ''), language),
        quantity = coalesce(v_quantity, quantity)
    where id = v_open_id;
  else
    insert into public.abandoned_checkouts (email, user_id, language, payment_intent_id, quantity)
    values (lower(btrim(p_email)), p_user_id, coalesce(nullif(p_language, ''), 'fr'), p_payment_intent_id, v_quantity);
  end if;
end;
$$;

grant execute on function public.track_abandoned_checkout(text, text, uuid, text, integer) to anon, authenticated;

alter table public.products
  add column if not exists original_price numeric(10, 2);

update public.products
set original_price = 189
where original_price is null;
