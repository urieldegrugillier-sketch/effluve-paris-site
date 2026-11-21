// MONARK: Supabase Auth "Send Email" Hook: replaces Supabase's own bare,
// English-only default templates (password reset, signup confirmation,
// email change) with the site's real dark/bronze branding, reusing the same
// visual language as stripe-webhook's order-confirmation email, AND makes
// them respect the account's own language -- something Supabase's built-in
// template system has no concept of at all (its templates are static, one
// per project, with no per-user variable for it). Once this Hook is
// enabled (see the manual Dashboard step below), Supabase stops sending its
// own email entirely for every auth action and calls this function instead,
// which is fully responsible for building AND sending the real email via
// the same Resend setup stripe-webhook already uses.
//
// language comes from auth.users.user_metadata.language -- set at signup
// (js/account.js's createAccount(), see its own comment) and kept in sync
// afterward on every site language switch by that same file's
// monark:langchange listener. An account that signed up before this existed
// has no such field; this defaults to 'fr' in that case, matching
// js/i18n.js's own DEFAULT_LANG.
//
// ============================================================================
// MANUAL SETUP STEPS THIS ENVIRONMENT CAN'T DO FOR YOU (Supabase Dashboard):
//
// 1. Deploy this function first (`supabase functions deploy send-auth-email
//    --linked`) so step 2 has a real URL to point at.
// 2. Supabase Dashboard -> Authentication -> Hooks -> "Send Email" ->
//    Enable it, choose "HTTPS" as the hook type, and set the URL to:
//      https://kqpekwaoklqlrdpdlqbx.supabase.co/functions/v1/send-auth-email
//    (same project ref used throughout this codebase -- see
//    js/supabase-client.js's own SUPABASE_URL).
// 3. Supabase generates a signing secret at that point (starts with
//    "v1,whsec_") -- copy it EXACTLY as shown, then set it as a Supabase
//    secret (never hardcode it here or commit it):
//      supabase secrets set SEND_EMAIL_HOOK_SECRET=v1,whsec_... --linked
//    Without this set, every incoming hook call fails signature
//    verification below and this function responds 401 -- which means
//    Supabase will surface an error to whatever triggered the email
//    (signup/password reset/email change) rather than silently falling
//    back to its own default template, once the hook itself is enabled in
//    step 2. Get the secret set BEFORE flipping the hook on, or right after
//    -- either order is fine as long as both are done.
// 4. (Also needed for the localhost-redirect fix this Hook is bundled with,
//    separate from the Hook itself) Dashboard -> Authentication -> URL
//    Configuration: Site URL should be https://effluve-paris.fr, and
//    Redirect URLs must include https://effluve-paris.fr/account.html (or a
//    wildcard covering it) -- see js/account.js's own
//    AUTH_EMAIL_REDIRECT_URL comment for why this is required even though
//    that file already passes the right URL explicitly.
//
// Until steps 1-3 are done, this function is simply never invoked --
// Supabase keeps sending its own bare default-template emails exactly as
// today, nothing breaks in the meantime.
// ============================================================================
//
// auth: none of this project's usual withSupabase()/verify_jwt machinery --
// same reasoning as stripe-webhook: Supabase's Auth service calls this
// directly, server-to-server, with no apikey/JWT header a browser call would
// carry (see supabase/config.toml's own verify_jwt = false for this
// function). Trust instead comes entirely from the Standard Webhooks
// signature verified below against SEND_EMAIL_HOOK_SECRET, the one and only
// gate on this endpoint -- without it, anyone who found this URL could make
// it send arbitrary "confirm your account" emails through this project's
// Resend account to any address.
import "@supabase/functions-js/edge-runtime.d.ts";
import { Webhook } from "standardwebhooks";
// Pure, importable builder (also used by scripts/send-test-auth-email.mjs).
import { buildAuthEmail, FROM_ADDRESS, WEBSITE_URL } from "./email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SEND_EMAIL_HOOK_SECRET = Deno.env.get("SEND_EMAIL_HOOK_SECRET");

const DEFAULT_REDIRECT_URL = `${WEBSITE_URL}/account.html`;

interface HookUser {
  email?: string;
  user_metadata?: Record<string, unknown>;
}

interface HookEmailData {
  token_hash?: string;
  // The plain 6-digit OTP Supabase generates alongside token_hash for every
  // action type (not just signup) -- only actually used for "signup" below
  // (see buildAuthEmail()'s own isCodeEmail branch), but declared here
  // regardless so TypeScript doesn't complain about reading it off the
  // payload. NEVER logged anywhere in this file -- see every console.error
  // below, each of which names a problem without ever including this value
  // or the payload it came from verbatim.
  token?: string;
  redirect_to?: string;
  email_action_type?: string;
}

interface HookPayload {
  user: HookUser;
  email_data: HookEmailData;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }
  if (!SUPABASE_URL || !RESEND_API_KEY || !SEND_EMAIL_HOOK_SECRET) {
    console.error("send-auth-email: missing required environment configuration (see this file's own setup comment).");
    return new Response("Not configured.", { status: 500 });
  }

  // MUST be the raw, unparsed request body -- same reasoning as
  // stripe-webhook's own rawBody: the signature is computed over the exact
  // bytes sent, parsing to JSON and re-serializing isn't guaranteed
  // byte-identical.
  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers);

  let payload: HookPayload;
  try {
    // BUG FIX (caught by a local round-trip test against the real
    // `standardwebhooks` package before this ever ran against a live
    // Supabase request): Supabase's Dashboard displays this secret prefixed
    // "v1,whsec_..." -- but the Webhook class only strips its own
    // documented "whsec_" prefix, not Supabase's separate "v1," version
    // marker in front of it. Passing the secret through unstripped throws a
    // base64-decode error on EVERY request (confirmed: `new Webhook("v1,whsec_...")`
    // fails immediately, before verify() is ever reached) -- this would
    // have silently 500'd every single auth email, forever, until someone
    // noticed. Stripping "v1," here first is required, not optional.
    const wh = new Webhook(SEND_EMAIL_HOOK_SECRET.replace(/^v1,/, ""));
    payload = wh.verify(rawBody, headers) as HookPayload;
  } catch (err) {
    // Wrong/missing secret, a tampered payload, or a request that isn't
    // really from Supabase's Auth service at all -- reject outright, never
    // send an email off an unverified payload.
    console.error("send-auth-email: signature verification failed:", err instanceof Error ? err.message : err);
    return new Response("Invalid signature.", { status: 401 });
  }

  const { user, email_data } = payload || {};
  const email = user?.email;
  const tokenHash = email_data?.token_hash;
  const token = email_data?.token;
  const actionType = email_data?.email_action_type;
  if (!email || !actionType) {
    // Logs which fields were missing, never the payload itself -- the old
    // version here did `JSON.stringify(payload)`, which (now that token_hash/
    // token both carry real, usable secrets) would have logged them in full
    // on exactly this error path. Boolean presence checks only.
    console.error(
      "send-auth-email: hook payload missing required fields -- email:",
      !!email,
      "actionType:",
      !!actionType,
    );
    return new Response("Invalid payload.", { status: 400 });
  }

  // "signup" is the one action type this Hook renders as a 6-digit code
  // instead of a confirmation link (see buildAuthEmail()'s own isCodeEmail
  // branch and this file's header comment) -- it needs `token` (the plain
  // OTP), not `token_hash` (only used to build a clickable link).
  const isCodeEmail = actionType === "signup";
  if (isCodeEmail) {
    if (!token) {
      console.error("send-auth-email: signup hook payload missing token -- cannot render a verification code.");
      return new Response("Invalid payload.", { status: 400 });
    }
  } else if (!tokenHash) {
    console.error("send-auth-email: hook payload missing token_hash for action", actionType);
    return new Response("Invalid payload.", { status: 400 });
  }

  // Matches js/i18n.js's own DEFAULT_LANG = 'fr' fallback for an account
  // that signed up before language was ever captured (see this file's own
  // header comment).
  const language: "fr" | "en" = user.user_metadata?.language === "en" ? "en" : "fr";

  // Same GoTrue /verify endpoint + token/type/redirect_to shape Supabase's
  // own default templates build their ConfirmationURL from -- this Hook
  // takes over composing the EMAIL, not the verification flow itself, so
  // the link has to hit the exact same endpoint to keep working with
  // js/account.js's existing PASSWORD_RECOVERY/session handling downstream.
  // Never built (left undefined) for a code email -- isCodeEmail's own
  // branch in buildAuthEmail() never references it, see that function.
  const redirectTo = email_data.redirect_to || DEFAULT_REDIRECT_URL;
  const confirmationUrl = isCodeEmail
    ? undefined
    : `${SUPABASE_URL}/auth/v1/verify?token=${encodeURIComponent(tokenHash!)}&type=${encodeURIComponent(actionType)}&redirect_to=${encodeURIComponent(redirectTo)}`;

  const { subject, html, text } = buildAuthEmail(actionType, language, confirmationUrl, token);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [email], subject, html, text }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Resend API responded ${res.status}: ${errBody}`);
    }
  } catch (err) {
    // Deliberately NOT swallowed the way stripe-webhook's own confirmation
    // email failure is -- there, the payment already succeeded regardless
    // of the email; HERE, this email IS the only way the user can ever
    // complete this auth action (confirm signup, reset password, confirm a
    // new email). A non-2xx response makes Supabase surface a real error to
    // whatever client call triggered this (signUp()/resetPasswordForEmail()/
    // updateUser({email})) instead of silently reporting success while no
    // usable email ever arrives.
    console.error("send-auth-email: send failed for action", actionType, ":", err instanceof Error ? err.message : err);
    return new Response("Email send failed.", { status: 500 });
  }

  return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
});
