// Effluve Paris: Order confirmation (customer) and internal new-order notification emails, extracted from ./index.ts so they can be
// imported without side effects (no Deno.env, no Deno.serve, no network,
// no Supabase client): ./index.ts imports them for production, and
// scripts/send-test-emails.mjs imports them to send local previews.
// Node 24 loads this file directly via type stripping, so keep the syntax
// erasable (type annotations and interfaces only, no enums/namespaces)
// and keep it free of Deno.* globals and package imports.

// contact@ on effluve-paris.fr -- the domain verified in Resend (SPF/DKIM);
// sending "from" any other domain would get the message rejected by Resend
// outright, not just marked spam. contact@ specifically (not commandes@,
// used originally) because it's the address actually wired up in Cloudflare
// Email Routing to forward replies to the real inbox -- commandes@ had no
// such forwarding rule, so a customer reply to it would have gone nowhere.
export const FROM_ADDRESS = "Effluve Paris <contact@effluve-paris.fr>";
export const CONTACT_EMAIL = "contact@effluve-paris.fr";
// Internal ops inbox -- gets a plain notification every time an order is
// actually paid (see sendInternalOrderNotification()'s own call sites in
// reconcileOrder(), same three places sendOrderConfirmation() already
// fires from), so a real Gmail inbox anyone can already check, not another
// effluve-paris.fr address that would need its own Cloudflare Email Routing
// rule set up first (see FROM_ADDRESS's own comment on why contact@ was
// picked for exactly that reason on the CUSTOMER-facing side).
export const INTERNAL_NOTIFICATION_EMAIL = "effluvepariscontact@gmail.com";
// Same api.whatsapp.com format (not wa.me) as checkout.html/contact.html's
// own whatsappHref -- see those files' own comments on why: more reliable
// than wa.me at carrying the ?text= prefill through the mobile OS's
// wa.me -> WhatsApp app hand-off.
export const WHATSAPP_PHONE = "33605893897";
export const WEBSITE_URL = "https://effluve-paris.fr";
// Used by sendInternalOrderNotification()/sendTelegramOrderNotification()
// below -- both used to have no link back into the site at all, so tapping
// either notification from a phone went nowhere; this is the one place both
// need to point to (there's no per-order admin.html deep link -- Orders tab
// shows every pending order at a glance, no id/reference query param to
// build one from).
export const ADMIN_URL = `${WEBSITE_URL}/admin.html`;
// PNG (not the site's own assets/icons/effluve-word-dark-bg.svg) -- Outlook
// desktop's rendering engine (Word, not a real browser engine) has no SVG
// support at all, so a raster export is the only format guaranteed to
// display across mail clients; Gmail/Apple Mail/etc. would have been fine
// with the SVG, but Outlook wouldn't. Must be an absolute, publicly
// reachable URL -- email images are always linked, never inline data: URIs
// (most clients' spam filters penalize inline-embedded images heavily).
export const LOGO_URL = `${WEBSITE_URL}/assets/icons/effluve-word-dark-bg.png`;
// Same PNG-not-SVG reasoning as LOGO_URL above -- css/style.css's own
// .nav-logo stacks these two images (EFFLUVE + PARIS) via flex-column, which
// email HTML has no equivalent of; buildConfirmationEmail() reproduces the
// same visual relationship (PARIS centered beneath EFFLUVE, smaller, bronze)
// with a plain table instead. See that file's own .nav-logo-subword comment
// for where the 0.349 height ratio and 0.16 gap ratio (both reused below)
// come from.
export const PARIS_LOGO_URL = `${WEBSITE_URL}/assets/icons/paris-word-dark-bg.png`;
// Same PNG-not-source-format reasoning as LOGO_URL/PARIS_LOGO_URL above --
// the source (assets/images/02_fully_edited.webp, already this project's
// established small-thumbnail crop: js/cart.js's own PRODUCT.image, reused
// by cart-widget.js/checkout.html's own thumbnails) is WebP, which has the
// same inconsistent-across-clients support problem SVG does for email.
// email-product-thumb.png is a plain raster export at a fixed 400x400,
// generated the same headless-screenshot way as the two logo PNGs.
export const PRODUCT_THUMB_URL = `${WEBSITE_URL}/assets/images/email-product-thumb.png`;
// "See our fragrances" points at the shop page specifically, not the
// homepage LOGO_URL above still points to -- a customer who already has a
// confirmed order doesn't need another pitch for the brand in general, but
// might well want to look at (or reorder) the product itself.
export const PRODUCT_URL = `${WEBSITE_URL}/product.html`;
// Same figures as checkout.html's own SHIPPING_FEE/VAT_RATE consts --
// display-only "waived fee" lines, duplicated here (not imported) since
// Deno Edge Functions and this static site share no build step to import
// across. Keep in sync by hand if either ever changes on the checkout page.
export const SHIPPING_FEE = 5.9;
export const VAT_RATE = 0.2;

export interface InternalNotificationDetails {
  referenceNumber: string;
  // ISO timestamp of the order row (orders.created_at).
  createdAt: string;
  productName: string;
  quantity: number;
  // Current products.price; subtotal = unitPrice x quantity before any code.
  unitPrice: number;
  subtotal: number;
  // Amount taken off by promoCode (0 when none, or when not derivable).
  discount: number;
  promoCode: string;
  // Amount actually charged by Stripe.
  total: number;
  customerEmail: string;
  // "+33 612345678" from the checkout's Shipping step, or the account's own
  // phone as a fallback; "" when neither exists.
  customerPhone: string;
  isGuest: boolean;
  // Customer's site language at checkout (the language of their emails).
  customerLanguage: "fr" | "en";
  shippingName: string;
  shippingAddressLine1: string;
  shippingAddressLine2: string;
  shippingCity: string;
  shippingPostalCode: string;
  shippingCountry: string;
  // "Visa •••• 4242" (brand + last 4 only, from Stripe), or "" if unknown.
  paymentMethod: string;
}

// "23 novembre 2026 à 14:32", always in Paris time (the edge runtime is UTC).
export function formatParisDateTime(isoString: string): string {
  const d = new Date(isoString);
  const date = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" }).format(d);
  const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(d);
  return `${date} à ${time}`;
}

// Internal "new paid order" alert sent to the shop owner (French only).
// Same visual language as the customer confirmation (buildConfirmationEmail()
// below: dark card, logo header, photo-left/text-right product block,
// 13px label/value recap rows, bronze CTA), but with everything needed to
// prepare and ship the parcel: price breakdown, customer contact details,
// payment method, and the shipping address laid out as it should appear on
// the label. No reply/WhatsApp/legal footer: that's for customers.
export function buildInternalOrderNotificationEmail(details: InternalNotificationDetails): { subject: string; html: string; text: string } {
  const ref = details.referenceNumber || "-";
  const subject = `Nouvelle commande payée | ${ref}`;
  const missing = "Non renseigné";
  const productName = escapeHtml(details.productName);
  const productNameNatural = productName.replace(/\s\|\s/g, ", ");
  const orderDateTime = formatParisDateTime(details.createdAt);
  const totalFormatted = formatMoney(details.total);
  const preheader = `À préparer : ${details.quantity} × ${details.productName.replace(/\s\|\s/g, ", ")}${details.shippingName ? ` pour ${details.shippingName}` : ""}${details.shippingCity ? `, ${details.shippingCity}` : ""}.`;

  // Label layout: name, street, complement, "postal code + CITY", COUNTRY,
  // one item per line, the way it should be written on the parcel.
  const labelLines = [
    details.shippingName,
    details.shippingAddressLine1,
    details.shippingAddressLine2,
    [details.shippingPostalCode, details.shippingCity.toUpperCase()].filter(Boolean).join(" "),
    details.shippingCountry ? countryLabel(details.shippingCountry, true).toUpperCase() : "",
  ].filter(Boolean);
  const hasAddress = Boolean(details.shippingAddressLine1 && details.shippingCity);

  const row = (label: string, valueHtml: string, last = false) => `
                  <tr>
                    <td style="padding:10px 0;${last ? "" : "border-bottom:1px solid #2a2620;"}font-size:13px;color:#8f887c;">${label}</td>
                    <td style="padding:10px 0;${last ? "" : "border-bottom:1px solid #2a2620;"}font-size:13px;color:#ede7dd;text-align:right;">${valueHtml}</td>
                  </tr>`;
  const sectionTitle = (title: string) =>
    `<h2 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#d8b27c;text-transform:uppercase;letter-spacing:0.05em;">${title}</h2>`;
  const linkStyle = "color:#ede7dd;text-decoration:underline;";

  const orderRowsHtml = [
    row("Date et heure", escapeHtml(orderDateTime)),
    row("Prix unitaire", formatMoney(details.unitPrice)),
    row("Quantité", String(details.quantity)),
    row("Sous-total", formatMoney(details.subtotal)),
    row("Livraison", `<span style="text-decoration:line-through;color:#8f887c;">${formatMoney(SHIPPING_FEE)}</span> Offerte`),
    details.promoCode
      ? row(`Code promo (${escapeHtml(details.promoCode)})`, details.discount > 0 ? `&minus;${formatMoney(details.discount)}` : "Appliqué")
      : row("Code promo", "Aucun"),
    `
                  <tr>
                    <td style="padding:10px 0;font-size:13px;color:#8f887c;">Total payé</td>
                    <td style="padding:10px 0;font-size:13px;color:#d8b27c;text-align:right;font-weight:600;">${totalFormatted}</td>
                  </tr>`,
  ].join("");

  const customerRowsHtml = [
    row("Nom", details.shippingName ? escapeHtml(details.shippingName) : missing),
    row("E-mail", details.customerEmail ? `<a href="mailto:${escapeHtml(details.customerEmail)}" style="${linkStyle}">${escapeHtml(details.customerEmail)}</a>` : missing),
    row("Téléphone", details.customerPhone ? `<a href="tel:${escapeHtml(details.customerPhone.replace(/\s+/g, ""))}" style="${linkStyle}">${escapeHtml(details.customerPhone)}</a>` : missing),
    row("Type", details.isGuest ? "Invité" : "Compte client"),
    row("Langue", details.customerLanguage === "en" ? "Anglais" : "Français"),
    row("Paiement", details.paymentMethod ? escapeHtml(details.paymentMethod) : missing, true),
  ].join("");

  const labelHtml = hasAddress
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-collapse:collapse;">
                  <tr>
                    <td style="padding:16px 18px;background:#0a0908;border:1px solid #9c6b2e;font-family:'IBM Plex Mono',Consolas,'Courier New',monospace;font-size:14px;line-height:1.6;color:#ede7dd;">${labelLines.map(escapeHtml).join("<br>")}${details.customerPhone ? `<br>${escapeHtml(details.customerPhone)}` : ""}</td>
                  </tr>
                </table>`
    : `<p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#ede7dd;">${missing}</p>`;

  const html = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <style>
      :root { color-scheme: light dark; supported-color-schemes: light dark; }
      [data-ogsc] body, [data-ogsc] .email-bg { background-color: #0a0908 !important; }
      [data-ogsc] .email-card { background-color: #141210 !important; }
      [data-ogsc] h1, [data-ogsc] h2, [data-ogsc] p, [data-ogsc] td, [data-ogsc] span, [data-ogsc] a { color: #ede7dd !important; }
      .item-link:hover { text-decoration: underline !important; }
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
                <p style="margin:0 0 4px;font-size:14px;line-height:1.6;color:#8f887c;">Commande à préparer</p>
                <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#ede7dd;">Nouvelle commande payée</h1>
                <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#ede7dd;">Commande <strong>${escapeHtml(ref)}</strong> payée le ${escapeHtml(orderDateTime)}.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 4px;border-collapse:collapse;table-layout:fixed;">
                  <tr>
                    <td width="120" valign="top" style="padding:0 16px 0 0;">
                      <a href="${PRODUCT_URL}"><img src="${PRODUCT_THUMB_URL}" width="120" height="120" alt="${productName}" style="display:block;border:0;outline:none;width:120px;height:120px;border-radius:4px;"></a>
                    </td>
                    <td valign="top">
                      <p style="margin:0 0 4px;font-size:15px;font-weight:600;line-height:1.35;color:#d8b27c;"><a href="${PRODUCT_URL}" class="item-link" style="color:#d8b27c;text-decoration:none;"><span style="color:#d8b27c;">${productNameNatural} | ${escapeHtml(ref)}</span></a></p>
                      <p style="margin:0 0 10px;font-size:12px;line-height:1.4;color:#8f887c;">Quantité : ${details.quantity} × ${formatMoney(details.unitPrice)}</p>
                      <p style="margin:0;font-size:22px;font-weight:700;line-height:1.15;color:#ede7dd;">${totalFormatted}</p>
                    </td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-collapse:collapse;">${orderRowsHtml}
                </table>
                ${sectionTitle("Client")}
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-collapse:collapse;">${customerRowsHtml}
                </table>
                ${sectionTitle("Adresse de livraison (étiquette)")}
                ${labelHtml}
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td style="background:#9c6b2e;border:1px solid #9c6b2e;" align="center">
                      <a href="${ADMIN_URL}" style="display:inline-block;padding:14px 32px;font-family:'IBM Plex Mono',Consolas,monospace;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#000000;text-decoration:none;">Voir les commandes</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    "NOUVELLE COMMANDE PAYÉE",
    "",
    `Commande ${ref} payée le ${orderDateTime}.`,
    "",
    `Produit : ${details.productName}`,
    `Quantité : ${details.quantity} × ${formatMoney(details.unitPrice)}`,
    `Sous-total : ${formatMoney(details.subtotal)}`,
    `Livraison : ${formatMoney(SHIPPING_FEE)} (offerte)`,
    details.promoCode
      ? `Code promo (${details.promoCode}) : ${details.discount > 0 ? `-${formatMoney(details.discount)}` : "appliqué"}`
      : "Code promo : aucun",
    `Total payé : ${totalFormatted}`,
    "",
    "CLIENT",
    `Nom : ${details.shippingName || missing}`,
    `E-mail : ${details.customerEmail || missing}`,
    `Téléphone : ${details.customerPhone || missing}`,
    `Type : ${details.isGuest ? "Invité" : "Compte client"}`,
    `Langue : ${details.customerLanguage === "en" ? "Anglais" : "Français"}`,
    `Paiement : ${details.paymentMethod || missing}`,
    "",
    "ADRESSE DE LIVRAISON (ÉTIQUETTE)",
    ...(hasAddress ? [...labelLines, ...(details.customerPhone ? [details.customerPhone] : [])] : [missing]),
    "",
    `Voir les commandes : ${ADMIN_URL}`,
  ].join("\n");

  return { subject, html, text };
}

export interface ConfirmationEmailDetails {
  email: string;
  language: "fr" | "en";
  referenceNumber: string;
  productName: string;
  quantity: number;
  total: number;
  createdAt: string;
  subtotal: number;
  discount: number;
  promoCode: string;
  shippingName: string;
  shippingAddressLine1: string;
  shippingAddressLine2: string;
  shippingCity: string;
  shippingPostalCode: string;
  shippingCountry: string;
}

export function formatMoney(n: number): string {
  // Matches checkout.html's own money() exactly (€ prefix, en-US grouping/
  // decimal formatting) so the amount in the email reads identically to what
  // the customer already saw on the confirmation screen.
  return "€" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

// FR/BE are the only two ALLOWED_SHIPPING_COUNTRIES checkout.html's own
// Shipping <select> offers (see that file's own country dropdown) -- an
// unrecognized code (shouldn't happen, but a confirmation email is never
// worth erroring over) just falls back to showing the raw code as-is rather
// than hiding the country line entirely.
export function countryLabel(code: string, isFr: boolean): string {
  const names: Record<string, { fr: string; en: string }> = {
    FR: { fr: "France", en: "France" },
    BE: { fr: "Belgique", en: "Belgium" },
  };
  const entry = names[code.toUpperCase()];
  return entry ? (isFr ? entry.fr : entry.en) : code;
}

// "3 août 2026" (fr-FR) / "August 3, 2026" (en-US) -- Intl.DateTimeFormat is
// available in Deno's edge runtime same as any modern JS engine, no extra
// dependency needed the way a lot of date-formatting libraries would be.
export function formatOrderDate(isoString: string, isFr: boolean): string {
  return new Intl.DateTimeFormat(isFr ? "fr-FR" : "en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(isoString));
}

// shippingName is built client-side as `${firstName} ${lastName}`.trim()
// (see checkout.html's own call site) from two fields js/account.js's
// centralized MonarkValidateName already validates before Payment is ever
// reachable -- so in the normal case this is reliably exactly two tokens,
// not free text. This only has to handle what's left over: the field
// missing entirely (pre-this-feature orders, or metadata dropped), or a
// first token too short/symbol-only to safely greet someone with. Returns
// "" (never guesses) when nothing safe to use is found -- the caller falls
// back to an un-personalized greeting in that case.
export function extractFirstName(fullName: string): string {
  const firstToken = fullName.trim().split(/\s+/)[0] || "";
  if (firstToken.length < 2 || !/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(firstToken)) return "";
  return firstToken;
}

export function buildConfirmationEmail(details: ConfirmationEmailDetails): { subject: string; html: string; text: string } {
  const isFr = details.language === "fr";
  const totalFormatted = formatMoney(details.total);
  const shippingFeeFormatted = formatMoney(SHIPPING_FEE);
  const vatAmount = details.subtotal * VAT_RATE;
  const vatAmountFormatted = formatMoney(vatAmount);
  const productName = escapeHtml(details.productName);
  // js/cart.js's own PRODUCT.name convention ("MONARK Eau de Parfum |
  // 100ml") uses "|" to separate name from size -- fine standing alone (see
  // the Subject line's own comment on reusing that same convention there),
  // but combined with a THIRD piece of information (the order reference) on
  // one line, two bare pipes back to back read as a delimited field dump
  // rather than a sentence. Naturalized only for this compact-block line:
  // comma between name/size (reads like "Chanel No. 5, 100ml"), keeping a
  // single "|" before the reference (matches the Subject line's own "Name |
  // Detail" convention) rather than two pipes in a row.
  const productNameNatural = productName.replace(/\s\|\s/g, ", ");
  const orderDate = formatOrderDate(details.createdAt, isFr);

  // "|" not an em dash -- matches the sitewide separator convention (e.g.
  // js/cart.js's own PRODUCT.name, "MONARK Eau de Parfum | 100ml") rather
  // than an em dash, which wasn't used anywhere else on the site.
  const subject = isFr
    ? `Votre commande Effluve Paris | ${details.referenceNumber}`
    : `Your Effluve Paris order | ${details.referenceNumber}`;

  // Hidden preheader -- the snippet inbox previews (Gmail/Outlook/Apple
  // Mail's list view) show next to the subject line. Without one, clients
  // fall back to pulling in whatever text happens first in the visible
  // body, which here would be raw whitespace/the logo's alt text -- an
  // explicit, deliberately-written preheader controls what that preview
  // actually says.
  const preheader = isFr
    ? "Votre commande Effluve Paris est confirmée. Merci pour votre confiance."
    : "Your Effluve Paris order is confirmed. Thank you for your trust.";
  // Personalized when a usable first name was extracted from the shipping
  // metadata (see extractFirstName's own comment on why that's reliable in
  // the normal case), otherwise a plain generic opener -- never a guess.
  const firstName = extractFirstName(details.shippingName);
  const greeting = isFr
    ? (firstName ? `Bonjour ${escapeHtml(firstName)},` : "Bonjour,")
    : (firstName ? `Hello ${escapeHtml(firstName)},` : "Hello,");
  const greetingText = isFr
    ? (firstName ? `Bonjour ${firstName},` : "Bonjour,")
    : (firstName ? `Hello ${firstName},` : "Hello,");
  const heading = isFr ? "Merci pour votre commande" : "Thank you for your order";
  // UPDATE: the date used to be folded into this sentence as a parenthetical
  // ("commande EP-XXXX (commande du ...)") -- read as redundant ("commande
  // ... commande"), so it's dropped from here and moved to its own row in
  // the details table below instead (see labels.date / the new row right
  // after Reference).
  const introLineHtml = isFr
    ? `Votre commande <strong>${details.referenceNumber}</strong> a bien été confirmée.`
    : `Your order <strong>${details.referenceNumber}</strong> has been confirmed.`;
  const introLineText = isFr
    ? `Votre commande ${details.referenceNumber} a bien été confirmée.`
    : `Your order ${details.referenceNumber} has been confirmed.`;
  const thankYou = isFr
    ? "Nous vous remercions pour la confiance que vous accordez à Effluve Paris."
    : "We thank you for placing your trust in Effluve Paris.";
  // UPDATE (simplified further): dropped the delivery-timeframe parenthetical
  // and the "en France et en Belgique"/"to France and Belgium" shipping-zone
  // callout too -- the customer already knows where they live; the general
  // shipping zone is site policy, not something worth repeating in their own
  // receipt. One direct sentence instead of a parenthetical-laden one.
  const shipping = isFr
    ? "Votre commande sera expédiée sous 5 à 7 jours ouvrés."
    : "Your order will ship within 5 to 7 business days.";
  const signOff = isFr ? "À bientôt," : "See you soon,";
  const labels = {
    reference: isFr ? "Référence" : "Reference",
    date: isFr ? "Date" : "Date",
    product: isFr ? "Produit" : "Product",
    quantity: isFr ? "Quantité" : "Quantity",
    shippingFee: isFr ? "Livraison" : "Shipping",
    vat: isFr ? "TVA" : "VAT",
    free: isFr ? "Offerte" : "Free",
    total: isFr ? "Total réglé" : "Total paid",
    visitSite: isFr ? "Voir nos parfums" : "See our fragrances",
    shippingAddress: isFr ? "Adresse de livraison" : "Shipping address",
    name: isFr ? "Nom" : "Name",
    address: isFr ? "Adresse" : "Address",
    city: isFr ? "Ville" : "City",
    postalCode: isFr ? "Code postal" : "Postal code",
    country: isFr ? "Pays" : "Country",
    terms: isFr ? "CGV" : "Terms of Sale",
    privacy: isFr ? "Confidentialité" : "Privacy Policy",
  };
  // French typographic convention (space before the colon) matches how this
  // same "Label : value" pattern already reads sitewide (e.g. js/i18n.js's
  // own confirmationReference string) -- English drops that space per its
  // own convention instead.
  const quantityLine = isFr ? `${labels.quantity} : ${details.quantity}` : `${labels.quantity}: ${details.quantity}`;

  // Only shown when create-checkout-session's own metadata actually carried
  // it (see sendOrderConfirmation's own comment) -- line1 + city are treated
  // as the minimum needed for this to be worth showing at all, rather than
  // rendering a table with some rows blank.
  const hasShippingAddress = Boolean(details.shippingAddressLine1 && details.shippingCity);
  const addressLineHtml = [details.shippingAddressLine1, details.shippingAddressLine2].filter(Boolean).map(escapeHtml).join(", ");
  const addressLineText = [details.shippingAddressLine1, details.shippingAddressLine2].filter(Boolean).join(", ");
  const countryDisplay = countryLabel(details.shippingCountry, isFr);
  const shippingAddressSection = hasShippingAddress
    ? `
                <h2 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#d8b27c;text-transform:uppercase;letter-spacing:0.05em;">${labels.shippingAddress}</h2>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-collapse:collapse;">
                  ${details.shippingName ? `<tr>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#8f887c;">${labels.name}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#ede7dd;text-align:right;">${escapeHtml(details.shippingName)}</td>
                  </tr>` : ""}
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#8f887c;">${labels.address}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#ede7dd;text-align:right;">${addressLineHtml}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#8f887c;">${labels.city}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#ede7dd;text-align:right;">${escapeHtml(details.shippingCity)}</td>
                  </tr>
                  ${details.shippingPostalCode ? `<tr>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#8f887c;">${labels.postalCode}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#ede7dd;text-align:right;">${escapeHtml(details.shippingPostalCode)}</td>
                  </tr>` : ""}
                  <tr>
                    <td style="padding:10px 0;font-size:13px;color:#8f887c;">${labels.country}</td>
                    <td style="padding:10px 0;font-size:13px;color:#ede7dd;text-align:right;">${escapeHtml(countryDisplay)}</td>
                  </tr>
                </table>`
    : "";
  // Array of lines (not a pre-joined string) -- spread directly into the
  // final `text` build below so an absent shipping address contributes
  // nothing at all to the output, not even a stray blank line.
  const shippingAddressLinesText: string[] = hasShippingAddress
    ? [
        "",
        `${labels.shippingAddress}:`,
        ...(details.shippingName ? [`${labels.name}: ${details.shippingName}`] : []),
        `${labels.address}: ${addressLineText}`,
        `${labels.city}: ${details.shippingCity}`,
        ...(details.shippingPostalCode ? [`${labels.postalCode}: ${details.shippingPostalCode}`] : []),
        `${labels.country}: ${countryDisplay}`,
      ]
    : [];

  const footer = buildCustomerFooter(details.language, details.referenceNumber);

  // Date/Shipping(Free)/VAT(Free)/[Promo]/Total -- UPDATE: Subtotal removed
  // from this recap entirely (per request) -- with the compact block above
  // now showing the price prominently on its own, a Subtotal row down here
  // was one more figure to reconcile rather than useful detail, especially
  // since it was identical to Total on the (typical) no-promo/no-extra-fees
  // order anyway. computePriceBreakdown() still computes subtotal
  // internally (VAT is derived from it below), it's just never displayed.
  // Order otherwise still matches checkout.html's own summaryLinesHtml(),
  // minus its countdown-driven "Limited-Time Offer" line: that one reflects
  // a live, still-ticking site-wide promo at the moment of purchase, which
  // doesn't make sense to reconstruct after the fact in a settled order's
  // confirmation email.
  const promoLine = details.promoCode
    ? `
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#8f887c;">Promo (${escapeHtml(details.promoCode)})</td>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#ede7dd;text-align:right;">&minus;${formatMoney(details.discount)}</td>
                  </tr>`
    : "";
  const promoLinesText: string[] = details.promoCode ? [`Promo (${details.promoCode}): -${formatMoney(details.discount)}`] : [];

  const html = `<!doctype html>
<html lang="${details.language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Dark-mode lock: this design is INTENTIONALLY dark (matches the
         site's own --bg-void/bronze palette), not a light email that needs
         a dark variant -- these two tags tell Gmail/Apple Mail/Outlook
         "both schemes are supported as authored," which stops the more
         aggressive auto-inversion some clients apply to emails they assume
         were only designed for light mode. Meta tags alone aren't fully
         reliable across every client though (see the style block below). -->
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <style>
      :root { color-scheme: light dark; supported-color-schemes: light dark; }
      /* Outlook.com and Windows Mail apply their own dark-mode pass
         independently of the meta tags above, tagging elements with
         data-ogsc/data-ogsb rather than honoring prefers-color-scheme --
         re-asserting our own colors !important on that hook is the
         documented workaround (no equivalent needed for Apple
         Mail/iOS/Gmail, which respect the meta tags themselves). */
      [data-ogsc] body, [data-ogsc] .email-bg { background-color: #0a0908 !important; }
      [data-ogsc] .email-card { background-color: #141210 !important; }
      [data-ogsc] h1, [data-ogsc] p, [data-ogsc] td, [data-ogsc] span, [data-ogsc] a { color: #ede7dd !important; }
      .item-link:hover { text-decoration: underline !important; }
      ${CUSTOMER_FOOTER_CSS}
    </style>
  </head>
  <body style="margin:0;padding:0;background:#0a0908;font-family:'Manrope',Arial,sans-serif;color:#ede7dd;">
    <!-- Hidden preheader -- see this function's own preheader var comment.
         mso-hide:all + the visual-hiding trio (display:none is not enough
         alone in every client) keeps it out of the rendered body while
         still being the first text node any client reads for the preview
         snippet. -->
    ${preheaderHtml(preheader)}
    <!-- BUG FIX (mobile width): padding used to live directly on this
         <table style="...padding:40px 16px">, which -- in content-box sizing
         -- adds on top of width:100%, pushing the table 32px wider than its
         actual container and overflowing at narrow (~375px) widths.
         Confirmed via a headless-browser screenshot at 375px: the whole card
         was clipped at the right edge. Moving the padding onto the <td>
         instead (the standard HTML-email pattern -- also more broadly
         supported than table-level padding, which some Outlook builds drop
         outright) fixes the overflow and is safer across clients regardless. -->
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
                <p style="margin:0 0 4px;font-size:14px;line-height:1.6;color:#8f887c;">${greeting}</p>
                <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#ede7dd;">${heading}</h1>
                <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#ede7dd;">${introLineHtml}</p>
                <!-- Photo left / content right -- standard email two-column
                     pattern (a <table> row with two <td>s, not flexbox/grid,
                     which isn't reliably supported across mail clients).
                     table-layout:fixed is load-bearing, not decorative --
                     with the default auto layout, a nested element's own
                     preferred (content-driven) width can propagate up and
                     force this whole row wider than its 100% parent once
                     any cell holds a longish string (confirmed live in an
                     earlier round: product_name overflowed the card at a
                     375px mobile width without this). Fixed layout forces
                     the text column to actually take "whatever's left"
                     after the image column, wrapping its content to fit
                     instead of growing the table to fit its content.
                     UPDATE: labeled Reference/Product/Quantity/Total rows
                     replaced with three plain lines (name+reference combined,
                     quantity, price) per request -- see the three <p>s below.
                     The name+reference line is now allowed to wrap normally
                     (no more nowrap/ellipsis truncation from an earlier
                     round) since it's long enough on any realistic width
                     that a natural 2-line wrap reads better than truncating
                     "MONARK Eau de Parfum, 100ml | ABCD1234" down to
                     "MONARK Eau de …" with the reference cut off entirely. -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 4px;border-collapse:collapse;table-layout:fixed;">
                  <tr>
                    <td width="120" valign="top" style="padding:0 16px 0 0;">
                      <a href="${PRODUCT_URL}"><img src="${PRODUCT_THUMB_URL}" width="120" height="120" alt="${productName}" style="display:block;border:0;outline:none;width:120px;height:120px;border-radius:4px;"></a>
                    </td>
                    <td valign="top">
                      <p style="margin:0 0 4px;font-size:15px;font-weight:600;line-height:1.35;color:#d8b27c;"><a href="${PRODUCT_URL}" class="item-link" style="color:#d8b27c;text-decoration:none;"><span style="color:#d8b27c;">${productNameNatural} | ${details.referenceNumber}</span></a></p>
                      <p style="margin:0 0 10px;font-size:12px;line-height:1.4;color:#8f887c;">${quantityLine}</p>
                      <p style="margin:0;font-size:22px;font-weight:700;line-height:1.15;color:#ede7dd;">${totalFormatted}</p>
                    </td>
                  </tr>
                </table>
                <!-- Recap of everything NOT already shown at a glance above
                     -- same row anatomy (13px type, #8f887c/#ede7dd pair,
                     #2a2620 divider) as the block above it, just full-width
                     instead of sharing a column with the photo, so the two
                     read as one continuous table rather than two unrelated
                     ones. UPDATE: Total is now intentionally repeated as
                     this table's own final row too (per explicit request --
                     an earlier round had deliberately left it out here to
                     avoid the "was I charged twice?" read of Subtotal/Total
                     showing the same figure, but the two now sit far enough
                     apart, with a differently-styled bronze/bold row of its
                     own, that the repeat reads as reinforcement rather than
                     confusion). Styled identically to the compact block's
                     own Total row (bronze #d8b27c, font-weight 600) so it's
                     unmistakably the final number, not one more muted
                     breakdown line like Subtotal/Shipping/VAT above it. -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-collapse:collapse;">
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#8f887c;">${labels.date}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#ede7dd;text-align:right;">${orderDate}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#8f887c;">${labels.shippingFee}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#ede7dd;text-align:right;"><span style="text-decoration:line-through;color:#8f887c;">${shippingFeeFormatted}</span> ${labels.free}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#8f887c;">${labels.vat}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#ede7dd;text-align:right;"><span style="text-decoration:line-through;color:#8f887c;">${vatAmountFormatted}</span> ${labels.free}</td>
                  </tr>${promoLine}
                  <tr>
                    <td style="padding:10px 0;font-size:13px;color:#8f887c;">${labels.total}</td>
                    <td style="padding:10px 0;font-size:13px;color:#d8b27c;text-align:right;font-weight:600;">${totalFormatted}</td>
                  </tr>
                </table>
                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">${thankYou}</p>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#ede7dd;">${shipping}</p>${shippingAddressSection}
                <p style="margin:24px 0 24px;font-size:14px;line-height:1.6;color:#ede7dd;">${signOff}<br>Effluve Paris</p>
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <!-- Solid bronze fill, pure #000 text -- matches
                         css/style.css's own filled-bronze CTA convention
                         (.cart-preview-buy/.email-popup-submit/
                         .notfound-acquire-btn all use this exact
                         background+border+color triple, #000 rather than
                         --bg-void for the same WCAG AA contrast reason those
                         carry in their own comments) rather than the
                         previous transparent/outline treatment. -->
                    <td style="background:#9c6b2e;border:1px solid #9c6b2e;" align="center">
                      <a href="${PRODUCT_URL}" style="display:inline-block;padding:14px 32px;font-family:'IBM Plex Mono',Consolas,monospace;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#000000;text-decoration:none;">${labels.visitSite}</a>
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

  // Explicit text/plain part -- without this, Resend (like most transactional
  // email APIs) auto-generates one by stripping HTML tags from `html` above,
  // which collapses every table row's own whitespace-only separation into a
  // single dense run-on line ("Livraison €5.90 Offerte TVA €29.80 Offerte
  // Total réglé..."). Building it explicitly, with real \n line breaks
  // between every field, is the only way to make the plain-text fallback
  // (used by some clients/screen readers, or whenever "view plain text" is
  // picked) actually readable.
  const text = [
    "EFFLUVE PARIS",
    "",
    greetingText,
    heading,
    "",
    introLineText,
    "",
    `${labels.reference}: ${details.referenceNumber}`,
    `${labels.date}: ${orderDate}`,
    `${labels.product}: ${details.productName}`,
    PRODUCT_URL,
    `${labels.quantity}: ${details.quantity}`,
    `${labels.shippingFee}: ${shippingFeeFormatted} (${labels.free})`,
    `${labels.vat}: ${vatAmountFormatted} (${labels.free})`,
    ...promoLinesText,
    `${labels.total}: ${totalFormatted}`,
    "",
    thankYou,
    "",
    shipping,
    ...shippingAddressLinesText,
    "",
    signOff,
    "Effluve Paris",
    "",
    `${labels.visitSite}: ${PRODUCT_URL}`,
    "",
    footer.text,
  ].join("\n");

  return { subject, html, text };
}
