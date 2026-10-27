-- Google OAuth sign-in (supabase.auth.signInWithOAuth) inserts into
-- auth.users exactly like an email/password signUp() does, so the existing
-- on_auth_user_created -> handle_new_user() trigger (see
-- supabase/migrations/20260822000000_add_profiles_email_sync.sql for its
-- current definition) already fires for an OAuth signup and gives it the
-- same public.profiles row -- no new trigger needed, just two adjustments to
-- that function's own column values for a provider that never supplies our
-- own custom raw_user_meta_data keys:
--
-- 1. marketing_opt_in: previously coalesced to `true` whenever the key was
--    missing from raw_user_meta_data, as a backstop for an older cached
--    client script that forgot to send it (js/account.js's createAccount()
--    always sends an explicit true/false today). Google never sends this key
--    at all -- there is no client-side hook to inject it during
--    signInWithOAuth() -- so the old unconditional backstop would silently
--    opt every Google signup into marketing. Narrowed to only apply that
--    `true` backstop for the 'email' provider; any other provider (just
--    'google' today) with the key missing now defaults to false instead,
--    matching "marketing opt-in must not be pre-checked for social signups".
-- 2. first_name/last_name: previously read ONLY our own custom
--    'first_name'/'last_name' metadata keys (set by createAccount()'s own
--    signUp() call). Google's OAuth user info uses 'given_name'/
--    'family_name' instead, so those are now used as a fallback whenever our
--    own keys aren't present -- prefilling the profile from the Google
--    account exactly like an email signup prefills from its own form.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, first_name, last_name, marketing_opt_in, phone, dial_code, country, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'first_name', new.raw_user_meta_data->>'given_name'),
    coalesce(new.raw_user_meta_data->>'last_name', new.raw_user_meta_data->>'family_name'),
    coalesce(
      (new.raw_user_meta_data->>'marketing_opt_in')::boolean,
      new.raw_app_meta_data->>'provider' = 'email'
    ),
    new.raw_user_meta_data->>'phone',
    new.raw_user_meta_data->>'dial_code',
    new.raw_user_meta_data->>'country',
    new.email
  );
  return new;
end;
$$;
