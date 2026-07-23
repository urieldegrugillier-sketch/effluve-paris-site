-- Adds the columns js/phone-input.js's country selector needs (public.profiles
-- already has `phone`, added by an earlier migration -- confirmed via
-- `supabase gen types typescript --linked`, no dial_code/country existed yet)
-- and updates the public.handle_new_user() trigger so marketing consent and
-- phone/country entered at ACCOUNT CREATION (js/account.js's createAccount(),
-- via signUp()'s user metadata) actually land in the profile row immediately,
-- instead of only being settable afterward via Edit Profile.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for this
-- project. Safe to run more than once (IF NOT EXISTS / CREATE OR REPLACE).

alter table public.profiles
  add column if not exists dial_code text,
  add column if not exists country text;

-- Replaces the existing handle_new_user() (previously only copied
-- first_name/last_name) -- fetched directly from this project via
-- `supabase db query --linked` before writing this migration, so the
-- first_name/last_name half below is unchanged, not a guess.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $function$
begin
  insert into public.profiles (id, first_name, last_name, marketing_opt_in, phone, dial_code, country)
  values (
    new.id,
    new.raw_user_meta_data->>'first_name',
    new.raw_user_meta_data->>'last_name',
    coalesce((new.raw_user_meta_data->>'marketing_opt_in')::boolean, true),
    new.raw_user_meta_data->>'phone',
    new.raw_user_meta_data->>'dial_code',
    new.raw_user_meta_data->>'country'
  );
  return new;
end;
$function$;
