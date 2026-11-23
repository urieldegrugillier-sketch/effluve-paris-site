// Effluve Paris: Delivered notification email, extracted from ./index.ts so they can be
// imported without side effects (no Deno.env, no Deno.serve, no network,
// no Supabase client): ./index.ts imports them for production, and
// scripts/send-test-emails.mjs imports them to send local previews.
// Node 24 loads this file directly via type stripping, so keep the syntax
// erasable (type annotations and interfaces only, no enums/namespaces)
// and keep it free of Deno.* globals and package imports.

// Same constants/addresses as supabase/functions/mark-order-shipped -- see
// that file's own comments for why each one is what it is. Duplicated
// rather than imported, matching this project's existing "self-contained
// single-file functions" convention.
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

export interface DeliveredEmailDetails {
  language: "fr" | "en";
  firstName: string;
  referenceNumber: string;
  productName: string;
  deliveredAtIso: string;
}

export function buildDeliveredEmail(details: DeliveredEmailDetails): { subject: string; html: string; text: string } {
  const isFr = details.language === "fr";
  const productName = escapeHtml(details.productName);
  const productNameNatural = productName.replace(/\s\|\s/g, ", ");
  const ref = details.referenceNumber;
  const dateLocale = isFr ? "fr-FR" : "en-US";
  const deliveredDateLabel = new Date(details.deliveredAtIso).toLocaleDateString(dateLocale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const subject = isFr ? `Votre commande a été livrée | ${ref}` : `Your order has been delivered | ${ref}`;
  // Own sentence, never a repeat of the subject (see preheaderHtml()).
  const preheader = isFr
    ? "Votre parfum est arrivé, nous espérons qu'il vous plaira."
    : "Your fragrance has arrived, we hope you love it.";

  const firstName = details.firstName ? escapeHtml(details.firstName) : "";
  const greeting = firstName ? (isFr ? `Bonjour ${firstName},` : `Hello ${firstName},`) : isFr ? "Bonjour," : "Hello,";

  const heading = isFr ? "Votre commande a été livrée" : "Your order has been delivered";
  const introHtml = isFr
    ? `Votre commande <strong>${ref}</strong> a été livrée avec succès. Nous espérons qu'elle vous plaira !`
    : `Your order <strong>${ref}</strong> has been delivered successfully. We hope you love it!`;

  const deliveredLabel = isFr ? "Livrée le" : "Delivered on";

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

  // Same visual shell (header logos, card, footer/legal block) as
  // mark-order-shipped's own buildShippingEmail() -- see that function for
  // why each styling choice is what it is (dark-mode overrides, MSO/Outlook
  // considerations, etc.). The product/tracking info box is repurposed here
  // to highlight the delivery date instead of a tracking number.
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
                      <p style="margin:0 0 4px;font-size:12px;line-height:1.4;color:#8f887c;">${deliveredLabel}</p>
                      <p style="margin:0;font-size:22px;font-weight:700;line-height:1.15;color:#ede7dd;">${escapeHtml(deliveredDateLabel)}</p>
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
              <td style="padding:16px 32px 32px;text-align:center;">
                <p style="margin:0;font-size:11px;color:#6b6459;">${legalFooterHtml}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = isFr
    ? `${greeting.replace(/,$/, "")},\n\n${heading}\n\nVotre commande ${ref} (${productNameNatural}) a été livrée avec succès. Nous espérons qu'elle vous plaira !\n\n${details.productName} | ${ref}\n${PRODUCT_URL}\n\n${deliveredLabel} : ${deliveredDateLabel}\n\n${signOff}\nEffluve Paris\n\n${replyNoteText}\n${whatsappNoteText}\n\n${legalFooterText}`
    : `${greeting.replace(/,$/, "")},\n\n${heading}\n\nYour order ${ref} (${productNameNatural}) has been delivered successfully. We hope you love it!\n\n${details.productName} | ${ref}\n${PRODUCT_URL}\n\n${deliveredLabel}: ${deliveredDateLabel}\n\n${signOff}\nEffluve Paris\n\n${replyNoteText}\n${whatsappNoteText}\n\n${legalFooterText}`;

  return { subject, html, text };
}
