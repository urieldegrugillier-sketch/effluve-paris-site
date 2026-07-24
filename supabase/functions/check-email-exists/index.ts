// Server-side email-existence check for the account gate's email step (see
// js/account.js's mountAccountGate() / checkEmailExists()). This can't be
// done from client-side code: the publishable key has no way to query
// auth.users (no email column on public.profiles, RLS blocks reading any
// other user's row -- see findAccount()'s own comment on that), and probing
// signUp()/signInWithPassword() to test "does this email exist" is exactly
// the enumeration attack Supabase's own API design goes out of its way to
// prevent. So this function uses the service-role key -- server-side only,
// never shipped client-side -- to check via the GoTrue admin API, and
// returns ONLY a boolean. No email, no user id, no other account details:
// keeping the response to a single bit is deliberate, so even a scripted
// enumeration attempt against this endpoint can only ever learn "does this
// exact address match a registered account", nothing more.
//
// auth: "publishable" -- same wrapper/mode as create-checkout-session, and
// for the same reason: this is called straight from the browser (including
// guests with no session yet) via supabase.functions.invoke(), which sends
// this project's publishable/anon key as the `apikey` header. withSupabase()
// validates that header AND handles CORS/the OPTIONS preflight automatically
// ("standard supabase-js CORS headers", same as create-checkout-session gets
// for free) -- BUG FIX: the first version of this function skipped
// withSupabase() entirely (hand-rolled `fetch: async (req) => ...`) since it
// needs the *admin* client, not the RLS-scoped ctx.supabase a publishable
// caller normally gets. That saved nothing and cost CORS: with no wrapper,
// there was no Access-Control-Allow-Origin on the response OR on the OPTIONS
// preflight, so every browser call failed before this code ever ran (see the
// live console error this was filed against). ctx.supabase (publishable,
// RLS-scoped) is intentionally left unused below -- a separate, explicitly
// service-role-scoped client is constructed inside the handler instead, so
// the privileged admin.listUsers() call below can never accidentally run
// against the caller's own limited permissions.
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

interface RequestBody {
  email?: unknown;
}

// Supabase's admin API has no direct "get user by email" lookup -- listUsers()
// only takes page/perPage, so this pages through every registered user
// comparing emails case-insensitively (Supabase Auth emails are already
// stored lower-cased, but this doesn't rely on that). Capped at 50 pages
// (50,000 users at 1000/page) so this can't run away/time out against a very
// large user base -- MONARK is nowhere near that scale today. If that ever
// changes, a dedicated lookup (e.g. an indexed email column on
// public.profiles, populated by the handle_new_user() trigger, queried
// through a plain RLS-safe RPC) would scale far better than paging the whole
// admin user list on every email step submit.
const MAX_PAGES = 50;
const PER_PAGE = 1000;

// BUG FIX: live testing turned up intermittent 502s (console: "Edge Function
// returned a non-2xx status code") that weren't reproducible on demand --
// retrying the exact same request moments later would succeed. That pattern
// (fails, then succeeds unchanged on retry) points to a transient hiccup in
// the GoTrue admin API call itself (auth.admin.listUsers()), not a
// deterministic logic bug in the matching/pagination below -- repeated live
// calls with genuinely random emails always matched correctly once a
// response came back. Retrying the page fetch a couple of times with a short
// backoff absorbs that transient failure instead of surfacing it to the user
// as a broken email step.
const MAX_FETCH_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 300;

async function listUsersPage(supabaseAdmin: ReturnType<typeof createClient>, page: number) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (!error) return data;
    lastError = error;
    if (attempt < MAX_FETCH_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * attempt));
    }
  }
  throw lastError;
}

async function emailExists(
  supabaseAdmin: ReturnType<typeof createClient>,
  email: string,
): Promise<boolean> {
  const needle = email.toLowerCase();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await listUsersPage(supabaseAdmin, page);
    if (data.users.some((u) => (u.email || "").toLowerCase() === needle)) return true;
    if (data.users.length < PER_PAGE) return false; // last page reached
  }
  return false;
}

export default {
  fetch: withSupabase({ auth: "publishable" }, async (req) => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error("check-email-exists: SUPABASE_SERVICE_ROLE_KEY is not configured.");
      return Response.json({ error: "Not configured." }, { status: 500 });
    }

    let body: RequestBody;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }

    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json({ error: "Invalid email." }, { status: 400 });
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    try {
      const exists = await emailExists(supabaseAdmin, email);
      return Response.json({ exists });
    } catch (err) {
      console.error("check-email-exists: lookup failed:", err instanceof Error ? err.message : err);
      return Response.json({ error: "Lookup failed. Please try again." }, { status: 502 });
    }
  }),
};
