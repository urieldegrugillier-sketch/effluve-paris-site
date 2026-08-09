// Effluve Paris — account.html's "Delete Account" action (js/account.js's
// deleteAccount(), called from js/account-page.js's deleteConfirmBtn
// handler). Real deletion needs Supabase's admin/service-role API
// (auth.admin.deleteUser()) -- the publishable key the browser uses can't do
// it, and a service-role key must never ship client-side (it bypasses RLS
// entirely for every table) -- so this is the server-side follow-up
// js/account.js's own deleteAccount() comment always said was still needed;
// until this function existed, that call was just a stub that signed the
// browser out locally and deleted nothing at all.
//
// Cascade behavior confirmed directly against the live schema (not assumed):
//   - public.profiles.id -> auth.users.id ON DELETE CASCADE (the profile row
//     is removed automatically)
//   - public.orders.user_id -> auth.users.id ON DELETE SET NULL (past orders
//     are KEPT for accounting/business records, just detached from the
//     deleted account -- same reasoning e-commerce/accounting practice
//     generally applies: a "delete my account" request removes the account
//     and its personal profile, not the store's own transaction history)
// Both are enforced at the database level, so deleting the auth.users row
// below is the only operation this function needs to perform -- no manual
// profiles/orders cleanup required.
//
// auth: same reasoning/pattern as supabase/functions/mark-order-shipped --
// this needs to know WHICH real, signed-in user is calling, so verify_jwt
// stays true (supabase/config.toml) and the JWT is also independently
// resolved to a user below via auth.getUser(jwt), same double-check that
// file's own comment explains. Unlike mark-order-shipped, there's no
// authorization check beyond "is this a real, valid session" -- any
// authenticated user is always allowed to delete their OWN account (the
// userData.user.id this resolves to, never a client-supplied id), there's no
// separate permission concept for it the way is_admin gates that function.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Called directly from the browser (account.html) -- same manual CORS
// handling as mark-order-shipped, for the same reason (withSupabase() isn't
// used here either, see that file's own comment on why).
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("delete-account: missing required environment configuration.");
    return json(500, { error: "Not configured." });
  }

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) {
    return json(401, { error: "Missing authorization." });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // auth.getUser(jwt) cryptographically validates the token itself and
  // returns whichever user it belongs to -- this, not any client-supplied
  // id, is what gets deleted below, so a caller can never delete anyone's
  // account but their own regardless of what a request body might claim.
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return json(401, { error: "Invalid or expired session." });
  }

  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userData.user.id);
  if (deleteError) {
    console.error("delete-account: deleteUser failed for", userData.user.id, ":", deleteError.message);
    return json(500, { error: deleteError.message });
  }

  return json(200, { ok: true });
});
