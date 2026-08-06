-- Schedules supabase/functions/send-abandoned-cart-reminders to run every 15
-- minutes via pg_cron -- close enough to the 1h/3h thresholds it checks for
-- (a reminder landing a few minutes late is a non-issue; the "at most once"
-- guarantee comes from reminder_1_sent_at/reminder_2_sent_at being stamped
-- server-side, not from the schedule's own precision) without invoking the
-- function needlessly often at this project's real volume.
--
-- ============================================================================
-- WHY pg_cron + pg_net, not a "Scheduled Edge Function" dashboard feature:
-- Supabase has no separate "Scheduled Functions" product to check a plan
-- for -- pg_cron and pg_net are both plain Postgres extensions bundled with
-- EVERY Supabase project regardless of plan (Free tier included; this is
-- Supabase's own documented, standard way to invoke an Edge Function on a
-- schedule -- pg_cron schedules a SQL job, that job uses pg_net to make the
-- actual HTTP call to the function's URL). No plan upgrade or separate
-- product is needed for any of this.
--
-- ============================================================================
-- ONE MANUAL SETUP STEP THIS ENVIRONMENT CAN'T DO FOR YOU (same reasoning as
-- stripe-webhook's own setup comment -- a real secret can't be committed to
-- a migration file that lives in git):
--
-- The cron job below authenticates its call to send-abandoned-cart-reminders
-- with this project's SERVICE_ROLE_KEY as a Bearer token (that function
-- requires it -- see its own auth check) -- read here via
-- current_setting('app.settings.service_role_key'), a database-level setting
-- that has to be set once, directly in the SQL Editor (NEVER put the actual
-- key in a migration file):
--
--   alter database postgres set app.settings.service_role_key = 'eyJ...';
--
-- (Supabase Dashboard -> Project Settings -> API -> service_role key.)
-- New connections pick this up automatically; if the cron job's own request
-- logs (`select * from net._http_response order by created desc limit 5;`)
-- show 401s, this step hasn't been done yet (or the pooler needs a beat to
-- pick up the new setting -- reconnecting the SQL Editor session is enough).
--
-- Also requires pg_cron/pg_net to be enabled -- Supabase Dashboard ->
-- Database -> Extensions (both free, on every plan) -- the CREATE EXTENSION
-- statements below do this too, but only if the SQL Editor role has
-- privilege to; if either errors out, enable them from the Extensions page
-- instead and re-run the rest of this file.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor) for
-- this project. Safe to run more than once (CREATE EXTENSION IF NOT EXISTS /
-- unschedule-then-reschedule below).
-- ============================================================================

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Unschedule any previous run of this same job before recreating it --
-- cron.schedule() errors on a duplicate jobname otherwise, which would
-- otherwise make this file NOT safe to run twice (unlike every other
-- migration in this project).
select cron.unschedule(jobid)
from cron.job
where jobname = 'send-abandoned-cart-reminders';

select cron.schedule(
  'send-abandoned-cart-reminders',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://kqpekwaoklqlrdpdlqbx.supabase.co/functions/v1/send-abandoned-cart-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
