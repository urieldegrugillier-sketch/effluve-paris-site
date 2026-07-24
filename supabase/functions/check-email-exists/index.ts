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
// auth: not gated through @supabase/server's withSupabase() like
// create-checkout-session -- this needs the service-role client itself
// (admin.listUsers()), not a publishable-scoped one, so it's constructed
// directly from the SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY env vars Supabase
// injects into every Edge Function automatically. verify_jwt is off in
// config.toml (see that file), same as create-checkout-session, since a
// guest mid-checkout with no session yet still needs to call this.
import "@supabase/functions-js/edge-runtime.d.ts";
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

async function emailExists(
  supabase: ReturnType<typeof createClient>,
  email: string,
): Promise<boolean> {
  const needle = email.toLowerCase();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw error;
    if (data.users.some((u) => (u.email || "").toLowerCase() === needle)) return true;
    if (data.users.length < PER_PAGE) return false; // last page reached
  }
  return false;
}

export default {
  fetch: async (req: Request) => {
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

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    try {
      const exists = await emailExists(supabase, email);
      return Response.json({ exists });
    } catch (err) {
      console.error("check-email-exists: lookup failed:", err instanceof Error ? err.message : err);
      return Response.json({ error: "Lookup failed. Please try again." }, { status: 502 });
    }
  },
};
