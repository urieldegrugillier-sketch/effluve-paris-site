// Effluve Paris: Shipped notification email, extracted from ./index.ts so they can be
// imported without side effects (no Deno.env, no Deno.serve, no network,
// no Supabase client): ./index.ts imports them for production, and
// scripts/send-test-emails.mjs imports them to send local previews.
// Node 24 loads this file directly via type stripping, so keep the syntax
// erasable (type annotations and interfaces only, no enums/namespaces)
// and keep it free of Deno.* globals and package imports.

// Same constants/addresses as supabase/functions/stripe-webhook -- see that
// file's own comments for why each one is what it is (contact@ specifically
// wired up in Cloudflare Email Routing, WhatsApp's api.whatsapp.com format
// over wa.me, etc.). Duplicated rather than imported from a shared module,
// matching this project's existing "self-contained single-file functions"
// convention (see create-checkout-session's own comment on that).
export const FROM_ADDRESS = "Effluve Paris <contact@effluve-paris.fr>";
export const CONTACT_EMAIL = "contact@effluve-paris.fr";
export const WHATSAPP_PHONE = "33605893897";
export const WEBSITE_URL = "https://effluve-paris.fr";
export const LOGO_URL = `${WEBSITE_URL}/assets/icons/effluve-word-dark-bg.png`;
export const PARIS_LOGO_URL = `${WEBSITE_URL}/assets/icons/paris-word-dark-bg.png`;
export const PRODUCT_THUMB_URL = `${WEBSITE_URL}/assets/images/email-product-thumb.png`;
export const PRODUCT_URL = `${WEBSITE_URL}/product.html`;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

// ===== BEGIN SHARED CUSTOMER FOOTER =====
// One block, duplicated identically in the email.ts of stripe-webhook,
// mark-order-shipped, ship24-webhook and send-abandoned-cart-reminders
// (edge functions cannot share imports in this project). Edit all four
// copies together: scripts/send-test-emails.mjs refuses to run if they
// differ. Used by the customer emails tied to an order or a cart, never by
// the auth emails (send-auth-email), which stay short.
//
// Top to bottom: the three reassurance items, the reply/WhatsApp contact
// lines, the legal line. Emails must also put CUSTOMER_FOOTER_CSS in their
// <style> block so the reassurance row stacks on phones.

const FOOTER_SITE_URL = "https://effluve-paris.fr";
const FOOTER_CONTACT_EMAIL = "contact@effluve-paris.fr";
// api.whatsapp.com format (not wa.me), same as checkout.html/contact.html.
const FOOTER_WHATSAPP_PHONE = "33605893897";

// Explicit reply_to for every customer email sent through Resend, so a
// plain "Reply" always reaches the inbox Cloudflare Email Routing forwards.
export const REPLY_TO_ADDRESS = FOOTER_CONTACT_EMAIL;

// The site's three reassurance items.
//
// Wording source on the site: js/i18n.js, keys trustBar.shipping /
// trustBar.shippingDesc / trustBar.returns / trustBar.returnsDesc /
// trustBar.payment / trustBar.paymentDesc (FR block and EN block). That is
// what the trust bar on index.html, faq.html, contact.html etc. displays.
// The returns window ("14 jours") is the one stated in the CGV (cgv.html):
// if the CGV wording changes, update js/i18n.js AND this constant.
// scripts/send-test-emails.mjs checks every string below against
// js/i18n.js and refuses to run if they drift apart.
//
// Icons: gold line icons exported from the same trust-bar SVGs as 48x48
// PNGs (displayed at 24x24) by scripts/export-email-icons.mjs, served from
// the site's assets folder (inline SVG is stripped by Gmail).
export const REASSURANCE_ITEMS = [
  {
    icon: `${FOOTER_SITE_URL}/assets/icons/email-icon-shipping.png`,
    fr: { label: "Livraison gratuite", desc: "France et Belgique" },
    en: { label: "Free shipping", desc: "France and Belgium" },
  },
  {
    icon: `${FOOTER_SITE_URL}/assets/icons/email-icon-returns.png`,
    fr: { label: "Retours gratuits", desc: "Sous 14 jours" },
    en: { label: "Free returns", desc: "Within 14 days" },
  },
  {
    icon: `${FOOTER_SITE_URL}/assets/icons/email-icon-payment.png`,
    fr: { label: "Paiement sécurisé", desc: "Crypté via Stripe" },
    en: { label: "Secure payment", desc: "Encrypted by Stripe" },
  },
];

// Three columns on desktop, stacked on narrow screens (Gmail, Apple Mail and
// most mobile clients honour the media query; the others keep three ~150px
// columns, which still fit).
export const CUSTOMER_FOOTER_CSS = "@media only screen and (max-width: 480px) { .reassure-wrap { padding: 10px 26px !important; } .reassure-cell { display: block !important; width: 100% !important; padding: 10px 0 !important; } }";

function footerEscapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// orderRef: the order reference for order emails (pre-fills the mailto and
// WhatsApp messages and says "your order"), or "" for the cart reminders.
// Returns the card's last <tr> rows (html) and the plain-text tail (text).
export function buildCustomerFooter(language: "fr" | "en", orderRef: string): { html: string; text: string } {
  const isFr = language === "fr";
  const ref = orderRef.trim();

  const cells = REASSURANCE_ITEMS.map((item) => {
    const t = isFr ? item.fr : item.en;
    return `
                    <td class="reassure-cell" width="33%" valign="top" align="center" style="padding:20px 6px;text-align:center;">
                      <img src="${item.icon}" width="24" height="24" alt="${footerEscapeHtml(t.label)}" style="display:block;margin:0 auto 8px;border:0;outline:none;width:24px;height:24px;">
                      <p style="margin:0;font-size:12px;font-weight:600;line-height:1.4;color:#ede7dd;">${footerEscapeHtml(t.label)}</p>
                      <p style="margin:2px 0 0;font-size:11px;line-height:1.4;color:#8f887c;">${footerEscapeHtml(t.desc)}</p>
                    </td>`;
  }).join("");
  const reassuranceText = REASSURANCE_ITEMS.map((item) => {
    const t = isFr ? item.fr : item.en;
    return `${t.label} · ${t.desc}`;
  });

  const mailtoSubject = ref
    ? (isFr ? `Question à propos de ma commande ${ref}` : `Question about my order ${ref}`)
    : (isFr ? "Question à propos d'Effluve Paris" : "Question about Effluve Paris");
  const mailtoBody = ref
    ? (isFr ? `Bonjour,\n\nJ'ai une question à propos de ma commande ${ref} :\n\n` : `Hello,\n\nI have a question about my order ${ref}:\n\n`)
    : (isFr ? "Bonjour,\n\n" : "Hello,\n\n");
  const mailtoHref = `mailto:${FOOTER_CONTACT_EMAIL}?subject=${encodeURIComponent(mailtoSubject)}&body=${encodeURIComponent(mailtoBody)}`;
  const whatsappMessage = ref
    ? (isFr ? `Bonjour, j'ai une question à propos de ma commande ${ref}.` : `Hello, I have a question about my order ${ref}.`)
    : (isFr ? "Bonjour, j'ai une question." : "Hello, I have a question.");
  const whatsappHref = `https://api.whatsapp.com/send?phone=${FOOTER_WHATSAPP_PHONE}&text=${encodeURIComponent(whatsappMessage)}`;

  const linkStyle = "color:#d8b27c;";
  const replyHtml = ref
    ? (isFr
      ? `Une question sur votre commande&nbsp;? Répondez simplement à <a href="${mailtoHref}" style="${linkStyle}">cet e-mail</a>.`
      : `Any question about your order? Just reply to <a href="${mailtoHref}" style="${linkStyle}">this email</a>.`)
    : (isFr
      ? `Une question&nbsp;? Répondez simplement à <a href="${mailtoHref}" style="${linkStyle}">cet e-mail</a>.`
      : `Any question? Just reply to <a href="${mailtoHref}" style="${linkStyle}">this email</a>.`);
  const replyText = ref
    ? (isFr ? "Une question sur votre commande ? Répondez simplement à cet e-mail." : "Any question about your order? Just reply to this email.")
    : (isFr ? "Une question ? Répondez simplement à cet e-mail." : "Any question? Just reply to this email.");
  const whatsappHtml = isFr
    ? `Vous pouvez aussi nous écrire sur <a href="${whatsappHref}" style="${linkStyle}">WhatsApp</a>.`
    : `You can also reach us on <a href="${whatsappHref}" style="${linkStyle}">WhatsApp</a>.`;
  const whatsappText = isFr
    ? `Vous pouvez aussi nous écrire sur WhatsApp : ${whatsappHref}`
    : `You can also reach us on WhatsApp: ${whatsappHref}`;

  // Middle dots between items, never an em or en dash.
  const terms = isFr ? "CGV" : "Terms of Sale";
  const privacy = isFr ? "Confidentialité" : "Privacy Policy";
  const legalHtml = `<a href="${FOOTER_SITE_URL}" style="color:#8f887c;">Effluve Paris</a> · <a href="${FOOTER_SITE_URL}/cgv.html" style="color:#8f887c;">${terms}</a> · <a href="${FOOTER_SITE_URL}/confidentialite.html" style="color:#8f887c;">${privacy}</a>`;
  const legalText = `Effluve Paris (${FOOTER_SITE_URL}) · ${terms}: ${FOOTER_SITE_URL}/cgv.html · ${privacy}: ${FOOTER_SITE_URL}/confidentialite.html`;

  const html = `
            <tr>
              <td class="reassure-wrap" style="padding:0 26px;border-top:1px solid #2a2620;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                  <tr>${cells}
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;border-top:1px solid #2a2620;text-align:center;">
                <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#8f887c;">${replyHtml}</p>
                <p style="margin:0;font-size:12px;line-height:1.5;color:#8f887c;">${whatsappHtml}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px;border-top:1px solid #2a2620;text-align:center;">
                <p style="margin:0;font-size:11px;color:#6b655c;">${legalHtml}</p>
              </td>
            </tr>`;

  const text = [...reassuranceText, "", "---", replyText, whatsappText, "", legalText].join("\n");
  return { html, text };
}
// ===== END SHARED CUSTOMER FOOTER =====

export interface ShippingEmailDetails {
  language: "fr" | "en";
  firstName: string;
  referenceNumber: string;
  productName: string;
  trackingNumber: string;
  carrier: string;
  // Only ever non-empty when carrier === "autre" (see this file's own
  // top-level validation) -- the admin-typed carrier name shown as plain
  // text ("Mode de transport : ...") for the one carrier
  // carrierTrackingUrl() below never builds a link for.
  carrierOtherName: string;
  // Only actually used for Mondial Relay (see carrierTrackingUrl()'s own
  // comment) -- harmless to always pass, ignored by every other carrier's
  // branch.
  postalCode: string;
  isCorrection: boolean;
}

// Builds the carrier's own tracking-page URL for this exact number --
// Colissimo/Chronopost URLs given directly (already confirmed correct).
//
// BUG FIX: Mondial Relay previously used
// `?codeMarque=CC&numeroExpedition=...`, sourced from two secondary web
// results (an e-commerce integration help page and a tracking aggregator)
// since mondialrelay.fr itself blocks simple fetches -- that param shape
// turned out to be wrong/outdated. Confirmed instead via a real headless
// browser loading the actual live page (https://www.mondialrelay.fr/
// suivi-de-colis/) and reading its own tracking <form>: it's a GET form,
// action=the same URL, with exactly two inputs -- `parcelNumber` (the
// tracking number) AND `zipCode` (the RECIPIENT's own postal code -- not
// optional, Mondial Relay has no lookup-by-tracking-number-alone at all).
// postalCode here is that order's own shipping_postal_code (see
// OrderRow's own comment on where that's read from) -- if it's ever empty
// (an order predating shipping-address persistence), there's no way to
// build a working link, so this falls back to null exactly like the
// "autre"/unrecognized-carrier case, rather than emitting a link that's
// guaranteed to fail Mondial Relay's own required-field check.
export function carrierTrackingUrl(carrier: string, trackingNumber: string, postalCode: string): string | null {
  const encoded = encodeURIComponent(trackingNumber);
  switch (carrier) {
    case "colissimo":
      return `https://www.laposte.fr/outils/suivre-vos-envois?code=${encoded}`;
    case "chronopost":
      return `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${encoded}`;
    case "mondial_relay":
      if (!postalCode) return null;
      return `https://www.mondialrelay.fr/suivi-de-colis/?parcelNumber=${encoded}&zipCode=${encodeURIComponent(postalCode)}`;
    default:
      return null;
  }
}

// Reuses supabase/functions/stripe-webhook's own visual template wholesale
// (dark-mode lock meta/CSS, hidden preheader, stacked EFFLUVE/PARIS header
// logo linked home, photo-left/text-right block, bronze CTA to product.html,
// reply/WhatsApp + legal footer) -- see that file's own comments for why
// each piece is built the way it is; not re-explained line by line here.
// Content differs from the order-confirmation email on purpose: no price
// breakdown (irrelevant to a shipping notice), the tracking number takes
// the "hero" slot the price occupied there.
export function buildShippingEmail(details: ShippingEmailDetails): { subject: string; html: string; text: string } {
  const isFr = details.language === "fr";
  const productName = escapeHtml(details.productName);
  const productNameNatural = productName.replace(/\s\|\s/g, ", ");
  const ref = details.referenceNumber;

  const subject = details.isCorrection
    ? isFr
      ? `Mise à jour du suivi de votre commande | ${ref}`
      : `Update to your order's tracking | ${ref}`
    : isFr
      ? `Votre commande a été expédiée | ${ref}`
      : `Your order has shipped | ${ref}`;

  // Own sentence, never a repeat of the subject (see preheaderHtml()).
  const preheader = details.isCorrection
    ? isFr
      ? "Le numéro de suivi de votre colis a été corrigé, voici le bon lien."
      : "Your parcel's tracking number has been corrected, here is the right link."
    : isFr
      ? "Votre colis est en route, suivez-le en temps réel."
      : "Your parcel is on its way, track it in real time.";

  const firstName = details.firstName ? escapeHtml(details.firstName) : "";
  const greeting = firstName ? (isFr ? `Bonjour ${firstName},` : `Hello ${firstName},`) : isFr ? "Bonjour," : "Hello,";
  const greetingText = details.firstName
    ? (isFr ? `Bonjour ${details.firstName},` : `Hello ${details.firstName},`)
    : isFr ? "Bonjour," : "Hello,";

  const heading = details.isCorrection
    ? isFr ? "Mise à jour de votre numéro de suivi" : "Update to your tracking number"
    : isFr ? "Votre commande a été expédiée" : "Your order has shipped";

  const introHtml = details.isCorrection
    ? isFr
      ? `Nous vous écrivons au sujet de votre commande <strong>${ref}</strong> : le numéro de suivi précédemment communiqué a été corrigé. Nous nous excusons pour la confusion occasionnée.`
      : `We're writing about your order <strong>${ref}</strong>: the tracking number previously sent to you has been corrected. We apologize for any confusion this may have caused.`
    : isFr
      ? `Bonne nouvelle : votre commande <strong>${ref}</strong> est en route !`
      : `Good news: your order <strong>${ref}</strong> is on its way!`;
  const introText = details.isCorrection
    ? isFr
      ? `Nous vous écrivons au sujet de votre commande ${ref} : le numéro de suivi précédemment communiqué a été corrigé. Nous nous excusons pour la confusion occasionnée.`
      : `We're writing about your order ${ref}: the tracking number previously sent to you has been corrected. We apologize for any confusion this may have caused.`
    : isFr
      ? `Bonne nouvelle : votre commande ${ref} est en route !`
      : `Good news: your order ${ref} is on its way!`;

  const trackingLabel = details.isCorrection
    ? isFr ? "Nouveau numéro de suivi" : "New tracking number"
    : isFr ? "Numéro de suivi" : "Tracking number";
  const trackingUrl = carrierTrackingUrl(details.carrier, details.trackingNumber, details.postalCode);
  const trackingNumberHtml = trackingUrl
    ? `<a href="${trackingUrl}" style="color:#ede7dd;text-decoration:underline;">${escapeHtml(details.trackingNumber)}</a>`
    : escapeHtml(details.trackingNumber);

  // "autre" only (carrierOtherName is only ever non-empty then, see
  // ShippingEmailDetails' own comment) -- plain text naming the actual
  // carrier, never a link (carrierTrackingUrl() already returns null for
  // "autre", same as before this field existed -- there's no known
  // tracking-page URL pattern to build one from for a courier this project
  // doesn't otherwise integrate with).
  const carrierLabel = isFr ? "Mode de transport" : "Carrier";
  const carrierNameHtml = details.carrierOtherName
    ? `<p style="margin:8px 0 0;font-size:12px;line-height:1.4;color:#8f887c;">${carrierLabel} : <span style="color:#ede7dd;">${escapeHtml(details.carrierOtherName)}</span></p>`
    : "";
  const carrierNameText = details.carrierOtherName ? `${carrierLabel}: ${details.carrierOtherName}` : "";

  const signOff = isFr ? "À bientôt," : "See you soon,";
  const visitSiteLabel = isFr ? "Voir nos parfums" : "See our fragrances";

  const footer = buildCustomerFooter(details.language, ref);

  const html = `<!doctype html>
<html lang="${details.language}">
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
      ${CUSTOMER_FOOTER_CSS}
    </style>
  </head>
  <body style="margin:0;padding:0;background:#0a0908;font-family:'Manrope',Arial,sans-serif;color:#ede7dd;">
    ${preheaderHtml(preheader)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0a0908" class="email-bg" style="background:#0a0908;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#141210" class="email-card" style="max-width:520px;background:#141210;border:1px solid #2a2620;">
            <tr>
              <td style="padding:32px 32px 24px;text-align:center;border-bottom:1px solid #2a2620;">
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr><td align="center"><a href="${WEBSITE_URL}"><img src="${LOGO_URL}" width="220" height="36" alt="Effluve Paris" style="display:block;border:0;outline:none;width:220px;height:36px;"></a></td></tr>
                  <tr><td align="center" style="padding-top:6px;"><a href="${WEBSITE_URL}"><img src="${PARIS_LOGO_URL}" width="83" height="13" alt="" style="display:block;border:0;outline:none;width:83px;height:13px;"></a></td></tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 4px;font-size:14px;line-height:1.6;color:#8f887c;">${greeting}</p>
                <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#ede7dd;">${heading}</h1>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#ede7dd;">${introHtml}</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-collapse:collapse;table-layout:fixed;">
                  <tr>
                    <td width="120" valign="top" style="padding:0 16px 0 0;">
                      <a href="${PRODUCT_URL}"><img src="${PRODUCT_THUMB_URL}" width="120" height="120" alt="${productName}" style="display:block;border:0;outline:none;width:120px;height:120px;border-radius:4px;"></a>
                    </td>
                    <td valign="top">
                      <p style="margin:0 0 10px;font-size:15px;font-weight:600;line-height:1.35;color:#d8b27c;"><a href="${PRODUCT_URL}" class="item-link" style="color:#d8b27c;text-decoration:none;"><span style="color:#d8b27c;">${productNameNatural} | ${ref}</span></a></p>
                      <p style="margin:0 0 4px;font-size:12px;line-height:1.4;color:#8f887c;">${trackingLabel}</p>
                      <p style="margin:0;font-size:22px;font-weight:700;line-height:1.15;color:#ede7dd;">${trackingNumberHtml}</p>
                      ${carrierNameHtml}
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 24px;font-size:14px;line-height:1.6;color:#ede7dd;">${signOff}<br>Effluve Paris</p>
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td style="background:#9c6b2e;border:1px solid #9c6b2e;" align="center">
                      <a href="${PRODUCT_URL}" style="display:inline-block;padding:14px 32px;font-family:'IBM Plex Mono',Consolas,monospace;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#000000;text-decoration:none;">${visitSiteLabel}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>${footer.html}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    "EFFLUVE PARIS",
    "",
    greetingText,
    heading,
    "",
    introText,
    "",
    `${details.productName} | ${ref}`,
    PRODUCT_URL,
    `${trackingLabel}: ${details.trackingNumber}${trackingUrl ? ` (${trackingUrl})` : ""}`,
    ...(carrierNameText ? [carrierNameText] : []),
    "",
    signOff,
    "Effluve Paris",
    "",
    `${visitSiteLabel}: ${PRODUCT_URL}`,
    "",
    footer.text,
  ].join("\n");

  return { subject, html, text };
}
