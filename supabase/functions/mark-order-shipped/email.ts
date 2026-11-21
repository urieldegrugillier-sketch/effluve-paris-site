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

  const preheader = details.isCorrection
    ? isFr
      ? `Le numéro de suivi de votre commande ${ref} a été corrigé.`
      : `The tracking number for your order ${ref} has been corrected.`
    : isFr
      ? `Votre commande Effluve Paris est en route. Numéro de suivi : ${details.trackingNumber}.`
      : `Your Effluve Paris order is on its way. Tracking number: ${details.trackingNumber}.`;

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

  const mailtoSubject = isFr ? `Question à propos de ma commande ${ref}` : `Question about my order ${ref}`;
  const mailtoBody = isFr
    ? `Bonjour,\n\nJ'ai une question à propos de ma commande ${ref} :\n\n`
    : `Hello,\n\nI have a question about my order ${ref}:\n\n`;
  const mailtoHref = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(mailtoSubject)}&body=${encodeURIComponent(mailtoBody)}`;
  const replyNote = isFr
    ? `Une question sur votre commande&nbsp;? Répondez simplement à <a href="${mailtoHref}" style="color:#d8b27c;">cet e-mail</a>.`
    : `Any question about your order? Just reply to <a href="${mailtoHref}" style="color:#d8b27c;">this email</a>.`;
  const replyNoteText = isFr
    ? `Une question sur votre commande ? Écrivez-nous : ${CONTACT_EMAIL}`
    : `Any question about your order? Email us: ${CONTACT_EMAIL}`;
  const whatsappText = isFr
    ? `Bonjour, j'ai une question à propos de ma commande ${ref}.`
    : `Hello, I have a question about my order ${ref}.`;
  const whatsappHref = `https://api.whatsapp.com/send?phone=${WHATSAPP_PHONE}&text=${encodeURIComponent(whatsappText)}`;
  const whatsappNote = isFr
    ? `Vous pouvez aussi nous écrire sur <a href="${whatsappHref}" style="color:#d8b27c;">WhatsApp</a>.`
    : `You can also reach us on <a href="${whatsappHref}" style="color:#d8b27c;">WhatsApp</a>.`;
  const whatsappNoteText = isFr
    ? `Vous pouvez aussi nous écrire sur WhatsApp : ${whatsappHref}`
    : `You can also reach us on WhatsApp: ${whatsappHref}`;

  const termsLabel = isFr ? "CGV" : "Terms of Sale";
  const privacyLabel = isFr ? "Confidentialité" : "Privacy Policy";
  const legalFooterHtml = `<a href="${WEBSITE_URL}" style="color:#8f887c;">Effluve Paris</a> · <a href="${WEBSITE_URL}/cgv.html" style="color:#8f887c;">${termsLabel}</a> · <a href="${WEBSITE_URL}/confidentialite.html" style="color:#8f887c;">${privacyLabel}</a>`;
  const legalFooterText = `Effluve Paris (${WEBSITE_URL}) · ${termsLabel}: ${WEBSITE_URL}/cgv.html · ${privacyLabel}: ${WEBSITE_URL}/confidentialite.html`;

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
    </style>
  </head>
  <body style="margin:0;padding:0;background:#0a0908;font-family:'Manrope',Arial,sans-serif;color:#ede7dd;">
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0a0908" class="email-bg" style="background:#0a0908;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#141210" class="email-card" style="max-width:520px;background:#141210;border:1px solid #2a2620;">
            <tr>
              <td style="padding:32px 32px 24px;text-align:center;border-bottom:1px solid #2a2620;">
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr><td align="center"><a href="${WEBSITE_URL}"><img src="${LOGO_URL}" width="220" height="36" alt="Effluve Paris" style="display:block;border:0;outline:none;width:220px;height:36px;"></a></td></tr>
                  <tr><td align="center" style="padding-top:6px;"><a href="${WEBSITE_URL}"><img src="${PARIS_LOGO_URL}" width="83" height="13" alt="Paris" style="display:block;border:0;outline:none;width:83px;height:13px;"></a></td></tr>
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
            </tr>
            <tr>
              <td style="padding:20px 32px;border-top:1px solid #2a2620;text-align:center;">
                <p style="margin:0 0 8px;font-size:12px;color:#8f887c;">${replyNote}</p>
                <p style="margin:0;font-size:12px;color:#8f887c;">${whatsappNote}</p>
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
    "---",
    replyNoteText,
    whatsappNoteText,
    "",
    legalFooterText,
  ].join("\n");

  return { subject, html, text };
}
