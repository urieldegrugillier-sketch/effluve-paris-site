/* MONARK — Supabase client initialization.
   Loaded on every page, right after the Supabase JS CDN script
   (https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2, which exposes the
   `supabase` global with .createClient()) and before any script that talks
   to Supabase (js/account.js on every page, product.html's own inline stock
   script). Exposes the initialized client as window.MonarkSupabase --
   deliberately not `window.supabase`, so it doesn't shadow the CDN library
   namespace itself.

   PLACEHOLDER VALUES BELOW -- replace SUPABASE_URL and
   SUPABASE_PUBLISHABLE_KEY with this project's real values (Supabase
   dashboard -> Project Settings -> API -> Project URL / Publishable key)
   before anything that touches auth, profiles, orders, or products will
   work. The publishable (anon) key is safe to ship client-side -- it's
   exactly what RLS policies exist to gate -- but it must be the
   publishable/anon key, never the service_role key. */
(function (global) {
  const SUPABASE_URL = 'https://kqpekwaoklqlrdpdlqbx.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_iVM0i0pn3lArNRYBfBv9dQ_lXDdP_5f';

  if (!global.supabase || typeof global.supabase.createClient !== 'function') {
    console.error('MonarkSupabase: Supabase JS SDK not loaded -- check the CDN <script> tag is present before this file.');
    return;
  }

  global.MonarkSupabase = global.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
})(window);
