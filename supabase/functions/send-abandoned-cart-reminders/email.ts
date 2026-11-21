// Effluve Paris: Abandoned-cart reminder emails (stage 1 and stage 2), extracted from ./index.ts so they can be
// imported without side effects (no Deno.env, no Deno.serve, no network,
// no Supabase client): ./index.ts imports them for production, and
// scripts/send-test-emails.mjs imports them to send local previews.
// Node 24 loads this file directly via type stripping, so keep the syntax
// erasable (type annotations and interfaces only, no enums/namespaces)
// and keep it free of Deno.* globals and package imports.

// Same sending identity/domain/asset URLs as stripe-webhook's own
// order-confirmation email -- see that function's own comments for why each
// one is what it is (contact@ for reply-forwarding, PNG not SVG/WebP for
// Outlook compatibility, etc.). Duplicated here rather than imported --
// matches this project's existing "self-contained single-file functions, no
// _shared/ import between them" convention (see create-checkout-session's
// own comment on that).
export const FROM_ADDRESS = "Effluve Paris <contact@effluve-paris.fr>";
export const WEBSITE_URL = "https://effluve-paris.fr";
export const LOGO_URL = `${WEBSITE_URL}/assets/icons/effluve-word-dark-bg.png`;
export const PARIS_LOGO_URL = `${WEBSITE_URL}/assets/icons/paris-word-dark-bg.png`;
export const PRODUCT_THUMB_URL = `${WEBSITE_URL}/assets/images/email-product-thumb.png`;
export const PRODUCT_URL = `${WEBSITE_URL}/product.html`;
// Matches js/cart.js's own single hardcoded PRODUCT.name -- this project's
// one current MONARK edition (same fallback stripe-webhook itself uses, see
// its own DEFAULT_PRODUCT_NAME). There's no persisted per-attempt cart
// contents to read a real product name from -- carts live in localStorage
// only, never synced server-side before checkout completes -- so this is
// deliberately the one thing this project actually sells, not a guess.
export const PRODUCT_NAME = "MONARK Eau de Parfum | 100ml";

export const DISCOUNT_PERCENT = 5;
export const DISCOUNT_EXPIRES_DAYS = 7;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================================
// Shared visual shell -- same dark card/logo header/legal footer chrome as
// stripe-webhook's own buildConfirmationEmail() (colors, fonts, dark-mode
// meta tags/Outlook data-ogsc hook, PNG logos, table-based two-column
// product layout), reused for both stages here since they're one file, not
// two separate Edge Functions -- the "no shared code between functions"
// convention this project follows is about not importing across DIFFERENT
// deployed functions, not about duplicating markup within the same one.
// ============================================================================
export interface ReminderEmailContent {
  language: "fr" | "en";
  preheader: string;
  heading: string;
  bodyHtml: string;
  bodyText: string[];
  ctaLabel: string;
}

export function buildReminderEmail(content: ReminderEmailContent): { subject: string; html: string; text: string } {
  const isFr = content.language === "fr";
  const labels = {
    terms: isFr ? "CGV" : "Terms of Sale",
    privacy: isFr ? "Confidentialité" : "Privacy Policy",
  };
  const legalFooterHtml = `<a href="${WEBSITE_URL}" style="color:#8f887c;">Effluve Paris</a> · <a href="${WEBSITE_URL}/cgv.html" style="color:#8f887c;">${labels.terms}</a> · <a href="${WEBSITE_URL}/confidentialite.html" style="color:#8f887c;">${labels.privacy}</a>`;
  const legalFooterText = `Effluve Paris (${WEBSITE_URL}) · ${labels.terms}: ${WEBSITE_URL}/cgv.html · ${labels.privacy}: ${WEBSITE_URL}/confidentialite.html`;

  const html = `<!doctype html>
<html lang="${content.language}">
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
      .item-link:hover { text-decoration: underline !important; }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#0a0908;font-family:'Manrope',Arial,sans-serif;color:#ede7dd;">
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${content.preheader}</div>
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
                <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#ede7dd;">${content.heading}</h1>
                ${content.bodyHtml}
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;border-collapse:collapse;table-layout:fixed;">
                  <tr>
                    <td width="120" valign="top" style="padding:0 16px 0 0;">
                      <a href="${PRODUCT_URL}"><img src="${PRODUCT_THUMB_URL}" width="120" height="120" alt="${escapeHtml(PRODUCT_NAME)}" style="display:block;border:0;outline:none;width:120px;height:120px;border-radius:4px;"></a>
                    </td>
                    <td valign="top">
                      <p style="margin:0;font-size:15px;font-weight:600;line-height:1.35;color:#d8b27c;"><a href="${PRODUCT_URL}" class="item-link" style="color:#d8b27c;text-decoration:none;"><span style="color:#d8b27c;">${escapeHtml(PRODUCT_NAME)}</span></a></p>
                    </td>
                  </tr>
                </table>
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:28px auto 0;">
                  <tr>
                    <td style="background:#9c6b2e;border:1px solid #9c6b2e;" align="center">
                      <a href="${PRODUCT_URL}" style="display:inline-block;padding:14px 32px;font-family:'IBM Plex Mono',Consolas,monospace;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#000000;text-decoration:none;">${content.ctaLabel}</a>
                    </td>
                  </tr>
                </table>
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
    ...content.bodyText,
    "",
    `${PRODUCT_NAME}`,
    PRODUCT_URL,
    "",
    `${content.ctaLabel}: ${PRODUCT_URL}`,
    "",
    "---",
    legalFooterText,
  ].join("\n");

  return { subject: content.preheader, html, text };
}

export function buildStage1Email(language: "fr" | "en"): { subject: string; html: string; text: string } {
  const isFr = language === "fr";
  const subject = isFr ? "Vous avez oublié quelque chose…" : "You left something behind…";
  const heading = isFr ? "Votre commande vous attend" : "Your order is waiting for you";
  const bodyHtml = isFr
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">Vous avez commencé une commande chez Effluve Paris, mais elle n'a pas été finalisée.</p>
       <p style="margin:0;font-size:14px;line-height:1.6;color:#ede7dd;">Il ne vous reste qu'une étape pour la compléter.</p>`
    : `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">You started an order with Effluve Paris, but it wasn't completed.</p>
       <p style="margin:0;font-size:14px;line-height:1.6;color:#ede7dd;">Just one step left to finish it.</p>`;
  const bodyText = isFr
    ? ["Vous avez commencé une commande chez Effluve Paris, mais elle n'a pas été finalisée.", "Il ne vous reste qu'une étape pour la compléter."]
    : ["You started an order with Effluve Paris, but it wasn't completed.", "Just one step left to finish it."];
  const ctaLabel = isFr ? "Finaliser ma commande" : "Complete my order";

  const built = buildReminderEmail({ language, preheader: subject, heading, bodyHtml, bodyText, ctaLabel });
  return { ...built, subject };
}

export function buildStage2Email(language: "fr" | "en", discountCode: string): { subject: string; html: string; text: string } {
  const isFr = language === "fr";
  const subject = isFr ? `-5% sur votre commande | ${discountCode}` : `5% off your order | ${discountCode}`;
  const heading = isFr ? "Un dernier geste pour vous" : "One last thing for you";
  const discountBlockHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;border-collapse:collapse;">
      <tr>
        <td style="padding:16px;background:rgba(216,178,124,0.08);border:1px dashed #d8b27c;text-align:center;">
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#8f887c;">${isFr ? "Votre code" : "Your code"}</p>
          <p style="margin:0;font-family:'IBM Plex Mono',Consolas,monospace;font-size:20px;font-weight:600;letter-spacing:0.08em;color:#d8b27c;">${escapeHtml(discountCode)}</p>
        </td>
      </tr>
    </table>`;
  const validityNoteHtml = isFr
    ? `<p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:#8f887c;">Valable ${DISCOUNT_EXPIRES_DAYS} jours, à usage unique.</p>`
    : `<p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:#8f887c;">Valid for ${DISCOUNT_EXPIRES_DAYS} days, single use.</p>`;
  const bodyHtml = isFr
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">Votre commande chez Effluve Paris n'a toujours pas été finalisée.</p>
       <p style="margin:0;font-size:14px;line-height:1.6;color:#ede7dd;">Voici <strong>${DISCOUNT_PERCENT}%</strong> de réduction pour vous aider à franchir le pas.</p>
       ${discountBlockHtml}${validityNoteHtml}`
    : `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">Your Effluve Paris order still hasn't been completed.</p>
       <p style="margin:0;font-size:14px;line-height:1.6;color:#ede7dd;">Here's <strong>${DISCOUNT_PERCENT}%</strong> off to help you take the last step.</p>
       ${discountBlockHtml}${validityNoteHtml}`;
  const bodyText = isFr
    ? [
        "Votre commande chez Effluve Paris n'a toujours pas été finalisée.",
        `Voici ${DISCOUNT_PERCENT}% de réduction pour vous aider à franchir le pas.`,
        "",
        `Votre code : ${discountCode}`,
        `Valable ${DISCOUNT_EXPIRES_DAYS} jours, à usage unique.`,
      ]
    : [
        "Your Effluve Paris order still hasn't been completed.",
        `Here's ${DISCOUNT_PERCENT}% off to help you take the last step.`,
        "",
        `Your code: ${discountCode}`,
        `Valid for ${DISCOUNT_EXPIRES_DAYS} days, single use.`,
      ];
  const ctaLabel = isFr ? "Utiliser mon code" : "Use my code";

  const built = buildReminderEmail({ language, preheader: subject, heading, bodyHtml, bodyText, ctaLabel });
  return { ...built, subject };
}
