-- Adds an `email` column to public.profiles, kept in sync with
-- auth.users.email via triggers, so email is visible alongside every other
-- profile field in the Table Editor (and via SQL/PostgREST) instead of
-- requiring a manual join against auth.users, which isn't browsable there at
-- all.
--
-- DESIGN CHOICE: a synced column on profiles, not a view joining profiles +
-- auth.users. A view was the other option on the table, but it has a real
-- footgun here: Postgres views run with their OWNER's privileges by default
-- (security_invoker is off unless set), so a view created by this project's
-- own postgres/migration role and granted to `authenticated` would let it
-- reach into auth.users (which `authenticated` has no privileges on
-- directly) -- but that same owner-privilege trick also means the view would
-- silently BYPASS public.profiles' own RLS policies ("Users can view own
-- profile" / "Admins can view all profiles") entirely, unless its defining
-- query re-implements that exact same row filter by hand. That's a real risk
-- of exactly what this migration was asked not to do -- break/weaken
-- existing RLS -- and a second copy of the access-control logic to keep in
-- sync with the real policies forever after.
--
-- A plain column sidesteps all of that: RLS is enforced per ROW, not per
-- column, so the two existing SELECT policies on profiles automatically
-- cover this new column too, with no new logic to write or drift out of
-- sync -- a user who could already see their own profile row (and their own
-- email, via their own session) now also sees it as part of that same row;
-- an admin who could already see every profile row (is_admin_user()) now
-- sees email as part of it too. Nothing new is reachable that wasn't already
-- implied by those two policies. Table-level grants are unchanged for the
-- same reason -- `authenticated` already had table-wide SELECT/UPDATE/INSERT
-- on profiles (see supabase/migrations/20260808000000_grant_profiles_service_
-- role.sql and earlier), which already covers any new column without a
-- separate GRANT.

alter table public.profiles add column if not exists email text;

-- One-time backfill for every profile that already existed before this
-- column did -- every row is guaranteed a matching auth.users row (profiles.id
-- references it, see profiles_id_fkey), so this is a plain 1:1 sync, not a
-- guess.
update public.profiles p
set email = u.email
from auth.users u
where u.id = p.id;

-- Extends the existing signup trigger's own function (on_auth_user_created,
-- AFTER INSERT ON auth.users -- see the original handle_new_user() this
-- replaces) to also set email at creation time. Without this, a brand-new
-- signup's profiles.email would stay NULL until the UPDATE trigger below
-- ever fires for that user -- which it wouldn't, since INSERT never fires an
-- UPDATE trigger.
--
-- `set search_path = public` added here (the original definition didn't set
-- one) -- same SECURITY DEFINER hardening this project's own is_admin_user()
-- already uses (see supabase/migrations/20260806000100_fix_admin_rls_
-- recursion.sql), now applied consistently to this function too since it's
-- being replaced anyway. Purely a hardening addition -- the function's own
-- behavior is otherwise unchanged except for the new email column.
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
    new.raw_user_meta_data->>'first_name',
    new.raw_user_meta_data->>'last_name',
    coalesce((new.raw_user_meta_data->>'marketing_opt_in')::boolean, true),
    new.raw_user_meta_data->>'phone',
    new.raw_user_meta_data->>'dial_code',
    new.raw_user_meta_data->>'country',
    new.email
  );
  return new;
end;
$$;

-- New trigger: keeps profiles.email in sync whenever auth.users.email
-- actually changes going forward -- e.g. a completed "Secure Email Change"
-- confirmation (see js/account.js's updateAccount()/emailChangePending,
-- which already handles the client-side side of that same flow). The WHEN
-- clause means this never fires -- and never writes -- on every other
-- auth.users UPDATE (password change, last_sign_in_at bump, etc.), only a
-- row where the email column itself actually changed.
create or replace function public.handle_user_email_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.handle_user_email_update();
