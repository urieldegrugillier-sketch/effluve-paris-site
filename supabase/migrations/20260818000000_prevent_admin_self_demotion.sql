-- Safeguard against an admin removing their OWN is_admin flag via any
-- UPDATE to public.profiles -- whether through a future "manage admin
-- accounts" UI or a direct API call. No such UI exists yet (only one admin
-- account exists today, see admin_shipping's own comment introducing
-- is_admin), so this closes the gap before one ever gets built, rather than
-- depending on that future UI to remember to guard against it itself.
--
-- Deliberately a trigger, not an RLS WITH CHECK clause: WITH CHECK only ever
-- sees the proposed NEW row, with no direct way to compare it against the
-- row's CURRENT stored value -- and that OLD-vs-NEW comparison is exactly
-- what "the update would SET is_admin to false" needs. A WITH CHECK that
-- instead rejected every update merely RESULTING IN is_admin = false
-- (regardless of what it was before) would also reject every ordinary
-- non-admin user's own profile edits, since their row's is_admin is already
-- false and stays false through every unrelated field update (name,
-- address, ...) -- exactly the "existing profile update flows for
-- non-admin fields" this must NOT touch. A BEFORE UPDATE trigger gets OLD
-- and NEW directly, so it can catch the true -> false transition
-- specifically and nothing else.
--
-- auth.uid() = old.id is also what keeps this scoped to a genuine
-- self-service demotion attempt over a normal user session (publishable key
-- + that admin's own JWT) -- it naturally does NOT match a future
-- service-role Edge Function (no user JWT; auth.uid() is null server-side)
-- or a SQL Editor/database console session (runs as postgres, never through
-- auth.uid() at all), so a future *legitimate* "another admin revokes THIS
-- admin's access" flow, or direct SQL, stays unaffected -- only "an admin
-- turning off their own flag, themselves" is blocked. Triggers also aren't
-- skipped by RLS-exempt roles (service_role) the way RLS policies are, so
-- this holds regardless of which key made the request.
--
-- No SECURITY DEFINER: this only compares the OLD/NEW row values the
-- trigger machinery already hands it plus auth.uid() (a plain session-level
-- read, not a table lookup) -- nothing here needs elevated privileges, so it
-- runs as whichever role fired the UPDATE, least-privilege.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project, or via `supabase db query --linked -f <this file>`. Safe to
-- run more than once (CREATE OR REPLACE / DROP TRIGGER IF EXISTS).

create or replace function public.prevent_admin_self_demotion()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() = old.id and old.is_admin = true and new.is_admin = false then
    raise exception 'Admins cannot remove their own admin status.'
      using errcode = '42501'; -- insufficient_privilege -- PostgREST surfaces this as 403
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_admin_self_demotion on public.profiles;
create trigger prevent_admin_self_demotion
  before update on public.profiles
  for each row
  execute function public.prevent_admin_self_demotion();
