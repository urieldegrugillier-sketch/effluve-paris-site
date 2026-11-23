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

// Prices for the product block, read by ./index.ts from the same sources
// the site uses: products.price (what checkout charges) and
// products.original_price (the struck-through reference price, same figure
// as js/cart.js PRODUCT.originalPrice), plus the cart quantity stored on
// abandoned_checkouts.quantity. Never hardcoded here.
export interface CartPricing {
  quantity: number;
  unitPrice: number;
  // null when the products row has no original_price.
  originalPrice: number | null;
}

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

// Locale money: "141,55 €" (fr-FR) / "€141.55" (en-US). wholeEuros drops the
// cents for the headline ("47 €" / "€47").
export function formatEuros(n: number, isFr: boolean, wholeEuros = false): string {
  const digits = wholeEuros ? 0 : 2;
  return new Intl.NumberFormat(isFr ? "fr-FR" : "en-US", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

// The stage 2 offer, computed the same way checkout charges it:
// create-checkout-session rounds price x quantity to cents, then applies the
// code's percentage and rounds to cents again.
//   finalTotal = price x quantity x (1 - DISCOUNT_PERCENT/100)
//   reference  = originalPrice x quantity (falls back to price x quantity
//                when there is no higher reference price)
//   saved      = reference - finalTotal, rounded DOWN to the euro
// e.g. price 149, originalPrice 189, 5%: 1 unit -> 141.55, saved 47;
// 2 units -> 283.10, saved 94.
export function discountOffer(pricing: CartPricing): { finalTotal: number; referenceTotal: number; hasReference: boolean; savedWholeEuros: number } {
  const q = Math.max(1, Math.floor(pricing.quantity) || 1);
  const totalCents = Math.round(pricing.unitPrice * q * 100);
  const finalTotal = Math.round(totalCents * (1 - DISCOUNT_PERCENT / 100)) / 100;
  const hasReference = pricing.originalPrice !== null && pricing.originalPrice > pricing.unitPrice;
  const referenceTotal = Math.round((hasReference ? pricing.originalPrice! : pricing.unitPrice) * q * 100) / 100;
  // Epsilon guards against binary float noise turning 47.000 into 46.
  const savedWholeEuros = Math.floor(referenceTotal - finalTotal + 1e-9);
  return { finalTotal, referenceTotal, hasReference, savedWholeEuros };
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
  subject: string;
  preheader: string;
  heading: string;
  bodyHtml: string;
  bodyText: string[];
  // Right-hand column of the photo-left product block (name line included).
  productDetailsHtml: string;
  productText: string[];
  ctaLabel: string;
  // Button target: checkout.html restore link (see cartRestoreUrl()).
  ctaUrl: string;
}

// Checkout link of the reminder buttons. checkout.html (js/checkout-page.js)
// rebuilds the cart from qty when it is empty (e.g. on another device),
// applies promo through the normal promo-code flow, then strips these
// params from the URL. utm_* let GA4 attribute the visit to each reminder.
export function cartRestoreUrl(quantity: number, promoCode: string, campaign: "cart_reminder_1" | "cart_reminder_2"): string {
  const params = new URLSearchParams({ restore: "1", qty: String(Math.max(1, Math.floor(quantity) || 1)) });
  if (promoCode) params.set("promo", promoCode);
  params.set("utm_source", "email");
  params.set("utm_medium", "email");
  params.set("utm_campaign", campaign);
  return `${WEBSITE_URL}/checkout.html?${params.toString()}`;
}

function productNameLinkHtml(): string {
  const name = escapeHtml(PRODUCT_NAME.replace(/\s\|\s/g, ", "));
  return `<p style="margin:0 0 4px;font-size:15px;font-weight:600;line-height:1.35;color:#d8b27c;"><a href="${PRODUCT_URL}" class="item-link" style="color:#d8b27c;text-decoration:none;"><span style="color:#d8b27c;">${name}</span></a></p>`;
}

function quantityLabel(isFr: boolean, quantity: number): string {
  return isFr ? `Quantité : ${quantity}` : `Quantity: ${quantity}`;
}

export function buildReminderEmail(content: ReminderEmailContent): { subject: string; html: string; text: string } {
  const isFr = content.language === "fr";
  const footer = buildCustomerFooter(content.language, "");

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
      ${CUSTOMER_FOOTER_CSS}
    </style>
  </head>
  <body style="margin:0;padding:0;background:#0a0908;font-family:'Manrope',Arial,sans-serif;color:#ede7dd;">
    ${preheaderHtml(content.preheader)}
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
                <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#ede7dd;">${escapeHtml(content.heading)}</h1>
                ${content.bodyHtml}
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;border-collapse:collapse;table-layout:fixed;">
                  <tr>
                    <td width="120" valign="top" style="padding:0 16px 0 0;">
                      <a href="${PRODUCT_URL}"><img src="${PRODUCT_THUMB_URL}" width="120" height="120" alt="${escapeHtml(PRODUCT_NAME)}" style="display:block;border:0;outline:none;width:120px;height:120px;border-radius:4px;"></a>
                    </td>
                    <td valign="top">
                      ${content.productDetailsHtml}
                    </td>
                  </tr>
                </table>
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:28px auto 0;">
                  <tr>
                    <td style="background:#9c6b2e;border:1px solid #9c6b2e;" align="center">
                      <a href="${escapeHtml(content.ctaUrl)}" style="display:inline-block;padding:14px 32px;font-family:'IBM Plex Mono',Consolas,monospace;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#000000;text-decoration:none;">${escapeHtml(content.ctaLabel)}</a>
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
    content.heading,
    "",
    ...content.bodyText,
    "",
    PRODUCT_NAME,
    PRODUCT_URL,
    ...content.productText,
    "",
    `${content.ctaLabel}${isFr ? " :" : ":"} ${content.ctaUrl}`,
    "",
    footer.text,
  ].join("\n");

  return { subject: content.subject, html, text };
}

export function buildStage1Email(language: "fr" | "en", pricing: CartPricing): { subject: string; html: string; text: string } {
  const isFr = language === "fr";
  const quantity = Math.max(1, Math.floor(pricing.quantity) || 1);
  const lineTotal = Math.round(pricing.unitPrice * quantity * 100) / 100;
  const subject = isFr ? "Vous avez oublié quelque chose…" : "You left something behind…";
  const preheader = isFr
    ? "Votre parfum vous attend toujours, finalisez votre commande en un clic."
    : "Your fragrance is still waiting for you, complete your order in one click.";
  const heading = isFr ? "Votre commande vous attend" : "Your order is waiting for you";
  const bodyHtml = isFr
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">Vous avez commencé une commande chez Effluve Paris, mais elle n'a pas été finalisée.</p>
       <p style="margin:0;font-size:14px;line-height:1.6;color:#ede7dd;">Il ne vous reste qu'une étape pour la compléter.</p>`
    : `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">You started an order with Effluve Paris, but it wasn't completed.</p>
       <p style="margin:0;font-size:14px;line-height:1.6;color:#ede7dd;">Just one step left to finish it.</p>`;
  const bodyText = isFr
    ? ["Vous avez commencé une commande chez Effluve Paris, mais elle n'a pas été finalisée.", "Il ne vous reste qu'une étape pour la compléter."]
    : ["You started an order with Effluve Paris, but it wasn't completed.", "Just one step left to finish it."];

  // Same three lines as the order confirmation's product block: name,
  // quantity (with "2 × unit price" when there is more than one), price.
  const unitFormatted = formatEuros(pricing.unitPrice, isFr);
  const quantityLine = quantity > 1 ? `${quantityLabel(isFr, quantity)} × ${unitFormatted}` : quantityLabel(isFr, quantity);
  const productDetailsHtml = `${productNameLinkHtml()}
                      <p style="margin:0 0 10px;font-size:12px;line-height:1.4;color:#8f887c;">${escapeHtml(quantityLine)}</p>
                      <p style="margin:0;font-size:22px;font-weight:700;line-height:1.15;color:#ede7dd;">${escapeHtml(formatEuros(lineTotal, isFr))}</p>`;
  const productText = [
    quantityLabel(isFr, quantity),
    ...(quantity > 1 ? [isFr ? `Prix unitaire : ${unitFormatted}` : `Unit price: ${unitFormatted}`] : []),
    quantity > 1
      ? (isFr ? `Total : ${formatEuros(lineTotal, isFr)}` : `Total: ${formatEuros(lineTotal, isFr)}`)
      : (isFr ? `Prix : ${formatEuros(lineTotal, isFr)}` : `Price: ${formatEuros(lineTotal, isFr)}`),
  ];

  const ctaLabel = isFr ? "Finaliser ma commande" : "Complete my order";
  const ctaUrl = cartRestoreUrl(quantity, "", "cart_reminder_1");
  return buildReminderEmail({ language, subject, preheader, heading, bodyHtml, bodyText, productDetailsHtml, productText, ctaLabel, ctaUrl });
}

export function buildStage2Email(language: "fr" | "en", discountCode: string, pricing: CartPricing): { subject: string; html: string; text: string } {
  const isFr = language === "fr";
  const quantity = Math.max(1, Math.floor(pricing.quantity) || 1);
  const offer = discountOffer({ ...pricing, quantity });
  const savedLabel = formatEuros(offer.savedWholeEuros, isFr, true);
  // Headline is the amount saved in euros versus the site's reference price
  // (see discountOffer()), never the code's percentage.
  const heading = isFr ? `${savedLabel} offerts sur votre parfum` : `${savedLabel} off your fragrance`;
  const subject = `${heading} | ${discountCode}`;
  const preheader = isFr
    ? `Votre code personnel est valable ${DISCOUNT_EXPIRES_DAYS} jours, ne le laissez pas filer.`
    : `Your personal code is valid for ${DISCOUNT_EXPIRES_DAYS} days, don't let it slip away.`;

  const discountBlockHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;border-collapse:collapse;">
      <tr>
        <td style="padding:16px;background:rgba(216,178,124,0.08);border:1px dashed #d8b27c;text-align:center;">
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#8f887c;">${isFr ? "Votre code" : "Your code"}</p>
          <p style="margin:0;font-family:'IBM Plex Mono',Consolas,monospace;font-size:20px;font-weight:600;letter-spacing:0.08em;color:#d8b27c;">${escapeHtml(discountCode)}</p>
        </td>
      </tr>
    </table>`;
  const validityNote = isFr
    ? `Valable ${DISCOUNT_EXPIRES_DAYS} jours, pour une seule utilisation. Non cumulable avec un autre code.`
    : `Valid for ${DISCOUNT_EXPIRES_DAYS} days, for a single use. Cannot be combined with another code.`;
  const intro = isFr
    ? "Votre commande chez Effluve Paris n'a toujours pas été finalisée."
    : "Your Effluve Paris order still hasn't been completed.";
  const offerLine = isFr
    ? "Pour vous aider à franchir le pas, voici un code rien que pour vous."
    : "To help you take the last step, here is a code just for you.";
  const bodyHtml = `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">${escapeHtml(intro)}</p>
       <p style="margin:0;font-size:14px;line-height:1.6;color:#ede7dd;">${escapeHtml(offerLine)}</p>
       ${discountBlockHtml}
       <p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:#8f887c;">${escapeHtml(validityNote)}</p>`;
  const bodyText = [intro, offerLine, "", isFr ? `Votre code : ${discountCode}` : `Your code: ${discountCode}`, validityNote];

  // Struck-through reference price (original price x quantity), then the
  // price with the code, then where the saving comes from.
  const referenceFormatted = formatEuros(offer.referenceTotal, isFr);
  const finalFormatted = formatEuros(offer.finalTotal, isFr);
  const offerExplainer = offer.hasReference
    ? (isFr ? `Offre en cours + ${DISCOUNT_PERCENT}% supplémentaires avec votre code` : `Current offer + an extra ${DISCOUNT_PERCENT}% with your code`)
    : (isFr ? `${DISCOUNT_PERCENT}% supplémentaires avec votre code` : `An extra ${DISCOUNT_PERCENT}% with your code`);
  const productDetailsHtml = `${productNameLinkHtml()}
                      <p style="margin:0 0 10px;font-size:12px;line-height:1.4;color:#8f887c;">${escapeHtml(quantityLabel(isFr, quantity))}</p>
                      <p style="margin:0 0 2px;font-size:14px;line-height:1.3;color:#8f887c;"><span style="text-decoration:line-through;color:#8f887c;">${escapeHtml(referenceFormatted)}</span></p>
                      <p style="margin:0 0 6px;font-size:22px;font-weight:700;line-height:1.15;color:#ede7dd;">${escapeHtml(finalFormatted)}</p>
                      <p style="margin:0;font-size:12px;line-height:1.4;color:#d8b27c;">${escapeHtml(offerExplainer)}</p>`;
  const productText = [
    quantityLabel(isFr, quantity),
    isFr ? `Prix de référence : ${referenceFormatted}` : `Reference price: ${referenceFormatted}`,
    isFr ? `Avec votre code : ${finalFormatted}` : `With your code: ${finalFormatted}`,
    offerExplainer,
  ];

  const ctaLabel = isFr ? "Utiliser mon code" : "Use my code";
  const ctaUrl = cartRestoreUrl(quantity, discountCode, "cart_reminder_2");
  return buildReminderEmail({ language, subject, preheader, heading, bodyHtml, bodyText, productDetailsHtml, productText, ctaLabel, ctaUrl });
}
