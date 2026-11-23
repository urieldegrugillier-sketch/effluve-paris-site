// Effluve Paris: pure email builder for the Supabase Auth "Send Email" Hook
// (see ./index.ts). Extracted from index.ts so it can be imported outside
// the edge runtime, e.g. by scripts/send-test-auth-email.mjs (Node 24 runs
// this .ts file directly via its built-in type stripping, so keep the syntax
// "erasable": plain type annotations and interfaces only, no enums, no
// namespaces, no parameter properties, and no Deno.* globals or remote
// imports in this file).
//
// SECURITY: the 6-digit code is only ever placed in the email BODY (HTML and
// plain text). It is never put in the subject line or the hidden preheader,
// both of which show up in lock-screen notifications, inbox lists, and
// third-party notification mirrors. Nothing in this file logs the token.

export const FROM_ADDRESS = "Effluve Paris <contact@effluve-paris.fr>";
export const WEBSITE_URL = "https://effluve-paris.fr";
const LOGO_URL = `${WEBSITE_URL}/assets/icons/effluve-word-dark-bg.png`;
const PARIS_LOGO_URL = `${WEBSITE_URL}/assets/icons/paris-word-dark-bg.png`;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface AuthEmailCopy {
  subject: string;
  // Hidden inbox-preview text. Never contains the code (see header comment).
  preheader: string;
  heading: string;
  bodyText: string;
  // Link-based emails (recovery/email_change/invite/default) set ctaLabel;
  // the code-based signup email sets codeIntro/codeExpiry/codeNote instead.
  ctaLabel?: string;
  // Sentence placed right before the code ("Your verification code is:").
  // Helps Gmail's native "Copy code" detection recognise the code.
  codeIntro?: string;
  // Line right under the code box, same style as codeIntro.
  codeExpiry?: string;
  // Grey note at the bottom (replaces the generic ignore note).
  codeNote?: string;
}

// Hidden inbox-preview snippet: the preheader sentence, followed by an
// invisible filler (combining grapheme joiner + zero-width non-joiner +
// non-breaking space, repeated) that fills the rest of the preview line, so
// Gmail/Apple Mail/Outlook stop there instead of appending the logo's alt
// text or the start of the body. Every email sets its own sentence, always
// different from its subject.
const PREHEADER_FILLER = "&#847;&zwnj;&nbsp;".repeat(100);
export function preheaderHtml(text: string): string {
  return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(text)}${PREHEADER_FILLER}</div>`;
}

// Covers every email_action_type this project's own code triggers (see
// js/account.js): "signup", "recovery", "email_change". "invite" is handled
// too (Supabase defines it for this hook). Any other value falls through to
// a generic confirmation email rather than a hard error, since this Hook is
// the only thing that sends auth emails at all once it is enabled.
function authEmailCopy(actionType: string, isFr: boolean): AuthEmailCopy {
  switch (actionType) {
    case "recovery": {
      const bodyText = isFr
        ? "Vous avez demandé la réinitialisation de votre mot de passe Effluve Paris. Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe."
        : "You requested a password reset for your Effluve Paris account. Click the button below to choose a new password.";
      return {
        subject: isFr ? "Réinitialisez votre mot de passe" : "Reset your password",
        preheader: isFr
          ? "Choisissez un nouveau mot de passe pour votre compte Effluve Paris."
          : "Choose a new password for your Effluve Paris account.",
        heading: isFr ? "Réinitialisation du mot de passe" : "Password reset",
        bodyText,
        ctaLabel: isFr ? "Réinitialiser mon mot de passe" : "Reset my password",
      };
    }
    case "email_change": {
      const bodyText = isFr
        ? "Cliquez sur le bouton ci-dessous pour confirmer votre nouvelle adresse e-mail Effluve Paris."
        : "Click the button below to confirm your new Effluve Paris email address.";
      return {
        subject: isFr ? "Confirmez votre nouvelle adresse e-mail" : "Confirm your new email address",
        preheader: isFr
          ? "Un clic suffit pour valider le changement d'adresse de votre compte."
          : "One click is all it takes to validate your account's new address.",
        heading: isFr ? "Confirmation de votre nouvel e-mail" : "Confirm your new email",
        bodyText,
        ctaLabel: isFr ? "Confirmer mon e-mail" : "Confirm my email",
      };
    }
    // Code-based: no button or link anywhere, see buildAuthEmail()'s
    // isCodeEmail branch.
    case "signup":
      return {
        subject: isFr ? "Votre code de vérification Effluve Paris" : "Your Effluve Paris verification code",
        preheader: isFr
          ? "Utilisez ce code pour vérifier votre adresse e-mail."
          : "Use this code to verify your email address.",
        heading: isFr ? "Voici votre code de vérification" : "Here is your verification code",
        bodyText: isFr
          ? "Merci pour votre inscription. Utilisez le code ci-dessous pour confirmer votre adresse e-mail et activer votre compte."
          : "Thank you for signing up. Use the code below to confirm your email address and activate your account.",
        // French typography: a space before the colon. Plain space here (the
        // HTML version swaps it for &nbsp; so the colon never wraps alone).
        codeIntro: isFr ? "Votre code de vérification est :" : "Your verification code is:",
        codeExpiry: isFr ? "Ce code expire dans 10 minutes." : "This code expires in 10 minutes.",
        codeNote: isFr
          ? "Si vous n'avez pas créé de compte, ignorez cet e-mail."
          : "If you didn't create an account, you can ignore this email.",
      };
    case "invite": {
      const bodyText = isFr
        ? "Merci pour votre inscription. Cliquez sur le bouton ci-dessous pour confirmer votre adresse e-mail et activer votre compte."
        : "Thank you for signing up. Click the button below to confirm your email address and activate your account.";
      return {
        subject: isFr ? "Confirmez votre compte Effluve Paris" : "Confirm your Effluve Paris account",
        preheader: isFr
          ? "Plus qu'une étape pour activer votre compte."
          : "Just one step left to activate your account.",
        heading: isFr ? "Bienvenue chez Effluve Paris" : "Welcome to Effluve Paris",
        bodyText,
        ctaLabel: isFr ? "Confirmer mon compte" : "Confirm my account",
      };
    }
    default: {
      console.error("send-auth-email: unrecognized email_action_type, using generic copy:", actionType);
      const bodyText = isFr
        ? "Cliquez sur le bouton ci-dessous pour confirmer cette demande."
        : "Click the button below to confirm this request.";
      return {
        subject: isFr ? "Confirmez votre demande" : "Confirm your request",
        preheader: isFr
          ? "Une confirmation est nécessaire pour finaliser votre demande."
          : "A confirmation is needed to complete your request.",
        heading: isFr ? "Confirmation requise" : "Confirmation required",
        bodyText,
        ctaLabel: isFr ? "Confirmer" : "Confirm",
      };
    }
  }
}

// Same dark card/logo header/legal footer chrome as stripe-webhook's own
// buildConfirmationEmail() (colors, fonts, dark-mode meta tags/Outlook
// data-ogsc hook, PNG logos), simplified to a message plus one button, or,
// for "signup", a code.
export function buildAuthEmail(
  actionType: string,
  language: "fr" | "en",
  confirmationUrl: string | undefined,
  token: string | undefined,
): { subject: string; html: string; text: string } {
  const isFr = language === "fr";
  const copy = authEmailCopy(actionType, isFr);
  const isCodeEmail = actionType === "signup";
  const code = token || "";
  const labels = {
    terms: isFr ? "CGV" : "Terms of Sale",
    privacy: isFr ? "Confidentialité" : "Privacy Policy",
  };
  const ignoreNote = isFr
    ? "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité."
    : "If you didn't request this, you can safely ignore this email.";
  const noteText = isCodeEmail ? (copy.codeNote || "") : ignoreNote;
  // Middle dot separators throughout (never an em or en dash).
  const legalFooterHtml = `<a href="${WEBSITE_URL}" style="color:#8f887c;">Effluve Paris</a> · <a href="${WEBSITE_URL}/cgv.html" style="color:#8f887c;">${labels.terms}</a> · <a href="${WEBSITE_URL}/confidentialite.html" style="color:#8f887c;">${labels.privacy}</a>`;
  const legalFooterText = `Effluve Paris (${WEBSITE_URL}) · ${labels.terms}: ${WEBSITE_URL}/cgv.html · ${labels.privacy}: ${WEBSITE_URL}/confidentialite.html`;

  // Signup code block. Layout, top to bottom:
  //   1. the intro sentence "Votre code de vérification est :" in its own <p>
  //      directly before the code (a strong signal for Gmail's native
  //      "Copy code" chip, which looks for a "code" phrase next to a short
  //      digit run);
  //   2. the gold-on-dark box, holding ONE <span> whose only child is the
  //      6 digits as a single continuous text node: no per-digit markup, no
  //      link, no letter-spacing (some clients insert real spaces on copy
  //      when letter-spacing is set, which breaks pasting). user-select: all
  //      makes one tap or click select the whole code where supported.
  //   3. the expiry line, same style as the intro sentence.
  // 28px monospace with tighter padding keeps it elegant on desktop while
  // staying comfortably readable on a phone (the box is ~170px wide, far
  // under any mobile viewport). No script and no fake "copy" button: email
  // clients strip JavaScript, so such a button could never work.
  const codeIntroHtml = escapeHtml(copy.codeIntro || "").replace(/ :$/, "&nbsp;:");
  const actionHtml = isCodeEmail
    ? `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#ede7dd;text-align:center;">${codeIntroHtml}</p>
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td style="background:#0a0908;border:1px solid #9c6b2e;padding:12px 24px;" align="center">
                      <span style="display:inline-block;font-family:'IBM Plex Mono',Consolas,'Courier New',monospace;font-size:28px;line-height:1.2;font-weight:600;color:#d8b27c;user-select:all;-webkit-user-select:all;">${escapeHtml(code)}</span>
                    </td>
                  </tr>
                </table>`
    : `<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td style="background:#9c6b2e;border:1px solid #9c6b2e;" align="center">
                      <a href="${confirmationUrl}" style="display:inline-block;padding:14px 32px;font-family:'IBM Plex Mono',Consolas,monospace;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#000000;text-decoration:none;">${escapeHtml(copy.ctaLabel || "")}</a>
                    </td>
                  </tr>
                </table>`;
  // Plain-text mirror: "Votre code de vérification est : 123456" alone on
  // its own line, or the "label: url" line for link-based emails.
  const actionText = isCodeEmail ? `${copy.codeIntro} ${code}` : `${copy.ctaLabel}: ${confirmationUrl}`;

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
    ${preheaderHtml(copy.preheader)}
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
                      <a href="${WEBSITE_URL}"><img src="${PARIS_LOGO_URL}" width="83" height="13" alt="" style="display:block;border:0;outline:none;width:83px;height:13px;"></a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#ede7dd;">${escapeHtml(copy.heading)}</h1>
                <p style="margin:0 0 28px;font-size:14px;line-height:1.6;color:#ede7dd;">${escapeHtml(copy.bodyText)}</p>
                ${actionHtml}
                ${isCodeEmail && copy.codeExpiry ? `<p style="margin:12px 0 0;font-size:14px;line-height:1.5;color:#ede7dd;text-align:center;">${escapeHtml(copy.codeExpiry)}</p>` : ""}
                <p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#8f887c;">${escapeHtml(noteText)}</p>
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
    actionText,
    "",
    ...(isCodeEmail && copy.codeExpiry ? [copy.codeExpiry, ""] : []),
    noteText,
    "",
    "---",
    legalFooterText,
  ].join("\n");

  return { subject: copy.subject, html, text };
}
