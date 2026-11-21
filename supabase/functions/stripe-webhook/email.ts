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
  productName: string;
  quantity: number;
  total: number;
  customerEmail: string;
  shippingName: string;
  shippingAddressLine1: string;
  shippingAddressLine2: string;
  shippingCity: string;
  shippingPostalCode: string;
  shippingCountry: string;
  promoCode: string;
}

// Same dark card/logo header as the customer-facing emails (see
// buildConfirmationEmail()'s own comment for why each visual choice is what
// it is) reused for brand consistency -- no WhatsApp/reply footer, no legal
// footer: none of that means anything to an internal reader. One plain text
// link to admin.html though (see ADMIN_URL) -- not the fuller bronze
// .cta-button treatment customer emails use (this reader already knows
// what the site looks like; a quiet link is enough), just something to tap
// straight into the Orders tab from a phone instead of this email being a
// dead end.
export function buildInternalOrderNotificationEmail(details: InternalNotificationDetails): { subject: string; html: string; text: string } {
  const subject = `Nouvelle commande payée | ${details.referenceNumber}`;

  const addressLines = [
    details.shippingName,
    details.shippingAddressLine1,
    details.shippingAddressLine2,
    [details.shippingPostalCode, details.shippingCity].filter(Boolean).join(" "),
    details.shippingCountry,
  ].filter(Boolean);
  const addressHtml = addressLines.length ? addressLines.map(escapeHtml).join("<br>") : "Non renseignée";
  const addressText = addressLines.length ? addressLines.join(", ") : "Non renseignée";

  const rows: [string, string][] = [
    ["Référence", details.referenceNumber || "-"],
    ["Produit", `${details.productName} × ${details.quantity}`],
    ["Total", formatMoney(details.total)],
    ["Client", details.customerEmail || "-"],
  ];
  if (details.promoCode) rows.push(["Code promo", details.promoCode]);

  const rowsHtml = rows.map(([label, value]) => `
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#8f887c;">${escapeHtml(label)}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#ede7dd;text-align:right;">${escapeHtml(value)}</td>
                  </tr>`).join("");
  const rowsText = rows.map(([label, value]) => `${label} : ${value}`).join("\n");

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
      [data-ogsc] h1, [data-ogsc] h2, [data-ogsc] p, [data-ogsc] td, [data-ogsc] span { color: #ede7dd !important; }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#0a0908;font-family:'Manrope',Arial,sans-serif;color:#ede7dd;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0a0908" class="email-bg" style="background:#0a0908;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#141210" class="email-card" style="max-width:520px;background:#141210;border:1px solid #2a2620;">
            <tr>
              <td style="padding:32px 32px 24px;text-align:center;border-bottom:1px solid #2a2620;">
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr><td align="center"><img src="${LOGO_URL}" width="220" height="36" alt="Effluve Paris" style="display:block;border:0;outline:none;width:220px;height:36px;"></td></tr>
                  <tr><td align="center" style="padding-top:6px;"><img src="${PARIS_LOGO_URL}" width="83" height="13" alt="Paris" style="display:block;border:0;outline:none;width:83px;height:13px;"></td></tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 20px;font-size:18px;font-weight:600;color:#ede7dd;">Nouvelle commande payée</h1>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-collapse:collapse;">
                  ${rowsHtml}
                </table>
                <h2 style="margin:0 0 8px;font-size:13px;font-weight:600;color:#d8b27c;text-transform:uppercase;letter-spacing:0.05em;">Adresse de livraison</h2>
                <p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:#ede7dd;">${addressHtml}</p>
                <p style="margin:0;font-size:13px;"><a href="${ADMIN_URL}" style="color:#d8b27c;">Voir dans l'administration &rarr;</a></p>
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
    rowsText,
    "",
    "Adresse de livraison :",
    addressText,
    "",
    `Voir dans l'administration : ${ADMIN_URL}`,
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

  // Pre-filled subject+body via mailto: URL params (RFC 6068) -- lets a
  // customer's reply already open addressed, subjected, and with the order
  // reference on hand instead of a bare "compose to contact@" with nothing
  // filled in. encodeURIComponent (not raw text) is required for both
  // subject and body -- an unescaped "&", "?", or newline in either would
  // otherwise be parsed as extra mailto query params / truncate the string.
  const mailtoSubject = isFr
    ? `Question à propos de ma commande ${details.referenceNumber}`
    : `Question about my order ${details.referenceNumber}`;
  const mailtoBody = isFr
    ? `Bonjour,\n\nJ'ai une question à propos de ma commande ${details.referenceNumber} :\n\n`
    : `Hello,\n\nI have a question about my order ${details.referenceNumber}:\n\n`;
  const mailtoHref = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(mailtoSubject)}&body=${encodeURIComponent(mailtoBody)}`;

  // Reply-by-email and WhatsApp are offered side by side, not one replacing
  // the other -- some customers will always prefer a quick chat message over
  // composing an email. mailto: link (not just prose) is the whole point of
  // this section -- see this function's own call site comment on FROM_ADDRESS
  // for why contact@ (not the old commandes@) is the address used here too.
  const replyNote = isFr
    ? `Une question sur votre commande&nbsp;? Répondez simplement à <a href="${mailtoHref}" style="color:#d8b27c;">cet e-mail</a>.`
    : `Any question about your order? Just reply to <a href="${mailtoHref}" style="color:#d8b27c;">this email</a>.`;
  const replyNoteText = isFr
    ? `Une question sur votre commande ? Écrivez-nous : ${CONTACT_EMAIL}`
    : `Any question about your order? Email us: ${CONTACT_EMAIL}`;
  const whatsappText = isFr
    ? `Bonjour, j'ai une question à propos de ma commande ${details.referenceNumber}.`
    : `Hello, I have a question about my order ${details.referenceNumber}.`;
  const whatsappHref = `https://api.whatsapp.com/send?phone=${WHATSAPP_PHONE}&text=${encodeURIComponent(whatsappText)}`;
  const whatsappNote = isFr
    ? `Vous pouvez aussi nous écrire sur <a href="${whatsappHref}" style="color:#d8b27c;">WhatsApp</a>.`
    : `You can also reach us on <a href="${whatsappHref}" style="color:#d8b27c;">WhatsApp</a>.`;
  const whatsappNoteText = isFr
    ? `Vous pouvez aussi nous écrire sur WhatsApp : ${whatsappHref}`
    : `You can also reach us on WhatsApp: ${whatsappHref}`;

  // Minimal transactional-receipt footer -- company name + links to the two
  // legal pages this site already has (cgv.html/confidentialite.html), NOT
  // a full "mentions légales" block (SIRET/RCS/registered address): those
  // don't exist yet for this micro-entreprise (see README's own "Before
  // launch" notes) and fabricating them here would be worse than omitting
  // them. Deliberately no unsubscribe link either -- this is a receipt tied
  // to a specific purchase, not a marketing send, so there's nothing to
  // unsubscribe from.
  const legalFooterHtml = `<a href="${WEBSITE_URL}" style="color:#8f887c;">Effluve Paris</a> · <a href="${WEBSITE_URL}/cgv.html" style="color:#8f887c;">${labels.terms}</a> · <a href="${WEBSITE_URL}/confidentialite.html" style="color:#8f887c;">${labels.privacy}</a>`;
  const legalFooterText = `Effluve Paris (${WEBSITE_URL}) · ${labels.terms}: ${WEBSITE_URL}/cgv.html · ${labels.privacy}: ${WEBSITE_URL}/confidentialite.html`;

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
    </style>
  </head>
  <body style="margin:0;padding:0;background:#0a0908;font-family:'Manrope',Arial,sans-serif;color:#ede7dd;">
    <!-- Hidden preheader -- see this function's own preheader var comment.
         mso-hide:all + the visual-hiding trio (display:none is not enough
         alone in every client) keeps it out of the rendered body while
         still being the first text node any client reads for the preview
         snippet. -->
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${preheader}</div>
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
                      <a href="${WEBSITE_URL}"><img src="${PARIS_LOGO_URL}" width="83" height="13" alt="Paris" style="display:block;border:0;outline:none;width:83px;height:13px;"></a>
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
    "---",
    replyNoteText,
    whatsappNoteText,
    "",
    legalFooterText,
  ].join("\n");

  return { subject, html, text };
}
