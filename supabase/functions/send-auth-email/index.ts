// MONARK — Supabase Auth "Send Email" Hook: replaces Supabase's own bare,
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SEND_EMAIL_HOOK_SECRET = Deno.env.get("SEND_EMAIL_HOOK_SECRET");

// Same sending identity/domain/asset URLs as stripe-webhook's own
// order-confirmation email -- see that function's own comments for why each
// one is what it is. Duplicated here rather than imported -- matches this
// project's existing "self-contained single-file functions" convention.
const FROM_ADDRESS = "Effluve Paris <contact@effluve-paris.fr>";
const WEBSITE_URL = "https://effluve-paris.fr";
const LOGO_URL = `${WEBSITE_URL}/assets/icons/effluve-word-dark-bg.png`;
const PARIS_LOGO_URL = `${WEBSITE_URL}/assets/icons/paris-word-dark-bg.png`;
const DEFAULT_REDIRECT_URL = `${WEBSITE_URL}/account.html`;

interface HookUser {
  email?: string;
  user_metadata?: Record<string, unknown>;
}

interface HookEmailData {
  token_hash?: string;
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
  const actionType = email_data?.email_action_type;
  if (!email || !tokenHash || !actionType) {
    console.error("send-auth-email: hook payload missing required fields:", JSON.stringify(payload).slice(0, 500));
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
  const redirectTo = email_data.redirect_to || DEFAULT_REDIRECT_URL;
  const confirmationUrl = `${SUPABASE_URL}/auth/v1/verify?token=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(actionType)}&redirect_to=${encodeURIComponent(redirectTo)}`;

  const { subject, html, text } = buildAuthEmail(actionType, language, confirmationUrl);

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface AuthEmailCopy {
  subject: string;
  heading: string;
  bodyText: string;
  ctaLabel: string;
}

// Covers every email_action_type this project's own code actually triggers
// (see js/account.js): "signup" (createAccount()'s signUp()), "recovery"
// (requestPasswordReset()'s resetPasswordForEmail()), "email_change"
// (updateAccount()'s auth.updateUser({email}), Supabase's "Secure Email
// Change" setting). "invite" is included too even though nothing in this
// codebase currently sends invites -- costs nothing to handle, and Supabase
// itself defines it as a possible action type for this same hook. Any OTHER
// value falls through to a generic confirmation email rather than a hard
// error -- this Hook is now the ONLY thing standing between a real auth
// action and the user ever getting an email for it at all, so an
// unrecognized type still has to result in something usable, not silence
// (logged loudly so it's actually noticed and this list gets updated).
function authEmailCopy(actionType: string, isFr: boolean): AuthEmailCopy {
  switch (actionType) {
    case "recovery":
      return {
        subject: isFr ? "Réinitialisez votre mot de passe" : "Reset your password",
        heading: isFr ? "Réinitialisation du mot de passe" : "Password reset",
        bodyText: isFr
          ? "Vous avez demandé la réinitialisation de votre mot de passe Effluve Paris. Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe."
          : "You requested a password reset for your Effluve Paris account. Click the button below to choose a new password.",
        ctaLabel: isFr ? "Réinitialiser mon mot de passe" : "Reset my password",
      };
    case "email_change":
      return {
        subject: isFr ? "Confirmez votre nouvelle adresse e-mail" : "Confirm your new email address",
        heading: isFr ? "Confirmation de votre nouvel e-mail" : "Confirm your new email",
        bodyText: isFr
          ? "Cliquez sur le bouton ci-dessous pour confirmer votre nouvelle adresse e-mail Effluve Paris."
          : "Click the button below to confirm your new Effluve Paris email address.",
        ctaLabel: isFr ? "Confirmer mon e-mail" : "Confirm my email",
      };
    case "signup":
    case "invite":
      return {
        subject: isFr ? "Confirmez votre compte Effluve Paris" : "Confirm your Effluve Paris account",
        heading: isFr ? "Bienvenue chez Effluve Paris" : "Welcome to Effluve Paris",
        bodyText: isFr
          ? "Merci pour votre inscription. Cliquez sur le bouton ci-dessous pour confirmer votre adresse e-mail et activer votre compte."
          : "Thank you for signing up. Click the button below to confirm your email address and activate your account.",
        ctaLabel: isFr ? "Confirmer mon compte" : "Confirm my account",
      };
    default:
      console.error("send-auth-email: unrecognized email_action_type, using generic copy:", actionType);
      return {
        subject: isFr ? "Confirmez votre demande" : "Confirm your request",
        heading: isFr ? "Confirmation requise" : "Confirmation required",
        bodyText: isFr
          ? "Cliquez sur le bouton ci-dessous pour confirmer cette demande."
          : "Click the button below to confirm this request.",
        ctaLabel: isFr ? "Confirmer" : "Confirm",
      };
  }
}

// Same dark card/logo header/legal footer chrome as stripe-webhook's own
// buildConfirmationEmail() (colors, fonts, dark-mode meta tags/Outlook
// data-ogsc hook, PNG logos) -- simplified here since there's no order/
// product/price data for this kind of email, just a message and one button.
function buildAuthEmail(actionType: string, language: "fr" | "en", confirmationUrl: string): { subject: string; html: string; text: string } {
  const isFr = language === "fr";
  const copy = authEmailCopy(actionType, isFr);
  const labels = {
    terms: isFr ? "CGV" : "Terms of Sale",
    privacy: isFr ? "Confidentialité" : "Privacy Policy",
  };
  // Security note -- same reasoning a real bank/payment provider's own
  // reset/confirmation emails carry: reassures a recipient who wasn't
  // expecting this that ignoring it is safe, without needing a reply-to
  // flow for something this low-stakes.
  const ignoreNote = isFr
    ? "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité."
    : "If you didn't request this, you can safely ignore this email.";
  const legalFooterHtml = `<a href="${WEBSITE_URL}" style="color:#8f887c;">Effluve Paris</a> — <a href="${WEBSITE_URL}/cgv.html" style="color:#8f887c;">${labels.terms}</a> · <a href="${WEBSITE_URL}/confidentialite.html" style="color:#8f887c;">${labels.privacy}</a>`;
  const legalFooterText = `Effluve Paris (${WEBSITE_URL}) — ${labels.terms}: ${WEBSITE_URL}/cgv.html — ${labels.privacy}: ${WEBSITE_URL}/confidentialite.html`;

  const html = `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <style>
      :root { color-scheme: light dark; supported-color-schemes: light dark; }
      [data-ogsc] body, [data-ogsc] .email-bg { background-color: #0a0908 !important; }
      [data-ogsc] .email-card { background-color: #141210 !important; }
      [data-ogsc] h1, [data-ogsc] p, [data-ogsc] td, [data-ogsc] span, [data-ogsc] a { color: #ede7dd !important; }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#0a0908;font-family:'Manrope',Arial,sans-serif;color:#ede7dd;">
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(copy.bodyText)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0a0908" class="email-bg" style="background:#0a0908;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#141210" class="email-card" style="max-width:520px;background:#141210;border:1px solid #2a2620;">
            <tr>
              <td style="padding:32px 32px 24px;text-align:center;border-bottom:1px solid #2a2620;">
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td align="center">
                      <a href="${WEBSITE_URL}"><img src="${LOGO_URL}" width="220" height="36" alt="Effluve Paris" style="display:block;border:0;outline:none;width:220px;height:36px;"></a>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="padding-top:6px;">
                      <a href="${WEBSITE_URL}"><img src="${PARIS_LOGO_URL}" width="83" height="13" alt="Paris" style="display:block;border:0;outline:none;width:83px;height:13px;"></a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#ede7dd;">${escapeHtml(copy.heading)}</h1>
                <p style="margin:0 0 28px;font-size:14px;line-height:1.6;color:#ede7dd;">${escapeHtml(copy.bodyText)}</p>
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td style="background:#9c6b2e;border:1px solid #9c6b2e;" align="center">
                      <a href="${confirmationUrl}" style="display:inline-block;padding:14px 32px;font-family:'IBM Plex Mono',Consolas,monospace;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#000000;text-decoration:none;">${escapeHtml(copy.ctaLabel)}</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#8f887c;">${escapeHtml(ignoreNote)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px;border-top:1px solid #2a2620;text-align:center;">
                <p style="margin:0;font-size:11px;color:#6b655c;">${legalFooterHtml}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    "EFFLUVE PARIS",
    "",
    copy.heading,
    "",
    copy.bodyText,
    "",
    `${copy.ctaLabel}: ${confirmationUrl}`,
    "",
    ignoreNote,
    "",
    "---",
    legalFooterText,
  ].join("\n");

  return { subject: copy.subject, html, text };
}
