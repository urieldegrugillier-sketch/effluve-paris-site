// Effluve Paris — admin.html's own privileged action: mark an order shipped
// (or correct an already-shipped order's tracking number) and send the
// matching customer email. Called from js/admin.js via
// supabase.functions.invoke('mark-order-shipped', ...), NOT a direct
// supabase-js .from('orders').update() the way the rest of this project's
// client code talks to Postgres -- the Resend API key this needs has to
// stay server-side only (same reasoning as supabase/functions/
// stripe-webhook's own FROM_ADDRESS/RESEND_API_KEY), so sending the email
// can't happen from admin.js itself. The actual row UPDATE could still go
// through RLS directly from the browser (see the "Admins can update
// shipping fields" policy in supabase/migrations/20260806000000_admin_
// shipping.sql, still in place as a defense-in-depth backstop) -- routing
// it through here too just keeps "was this a first-time ship or a
// correction, and which email does that mean" as one authoritative,
// server-side decision instead of trusting the client to report it
// honestly.
//
// auth: unlike create-checkout-session/check-email-exists (both
// withSupabase({auth:"publishable"}), callable by anyone including guests),
// this one needs to know WHICH real, signed-in user is calling and whether
// THEY specifically are an admin -- not something a bare publishable-key
// check can answer. Raw Deno.serve + manual JWT handling (same "no
// withSupabase" choice stripe-webhook already made, for its own different
// reason) rather than guessing at an "authenticated" mode this project's
// existing withSupabase() call sites never needed.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

// Same constants/addresses as supabase/functions/stripe-webhook -- see that
// file's own comments for why each one is what it is (contact@ specifically
// wired up in Cloudflare Email Routing, WhatsApp's api.whatsapp.com format
// over wa.me, etc.). Duplicated rather than imported from a shared module,
// matching this project's existing "self-contained single-file functions"
// convention (see create-checkout-session's own comment on that).
const FROM_ADDRESS = "Effluve Paris <contact@effluve-paris.fr>";
const CONTACT_EMAIL = "contact@effluve-paris.fr";
const WHATSAPP_PHONE = "33605893897";
const WEBSITE_URL = "https://effluve-paris.fr";
const LOGO_URL = `${WEBSITE_URL}/assets/icons/effluve-word-dark-bg.png`;
const PARIS_LOGO_URL = `${WEBSITE_URL}/assets/icons/paris-word-dark-bg.png`;
const PRODUCT_THUMB_URL = `${WEBSITE_URL}/assets/images/email-product-thumb.png`;
const PRODUCT_URL = `${WEBSITE_URL}/product.html`;

// Called directly from the browser (admin.html) -- withSupabase() normally
// hands this out for free, but that helper is deliberately not used here
// (see this file's own top comment), so CORS + the OPTIONS preflight are
// handled by hand.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("mark-order-shipped: missing required environment configuration.");
    return json(500, { error: "Not configured." });
  }

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) {
    return json(401, { error: "Missing authorization." });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // auth.getUser(jwt) cryptographically validates the token itself and
  // returns whichever user it belongs to -- no separate RLS-scoped client
  // needed just to answer "who is this." service_role's own profiles
  // lookup right after bypasses RLS entirely (as it always does), which is
  // fine here specifically because THIS lookup's only purpose is deciding
  // is_admin in the first place -- there's no self-referencing policy risk
  // the way supabase/migrations/20260806000100_fix_admin_rls_recursion.sql
  // had to fix for the browser-side RLS path.
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return json(401, { error: "Invalid or expired session." });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("is_admin")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError || !profile?.is_admin) {
    return json(403, { error: "Not authorized." });
  }

  let body: { orderId?: unknown; trackingNumber?: unknown; carrier?: unknown; carrierOtherName?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid request body." });
  }
  const orderId = typeof body.orderId === "string" ? body.orderId : "";
  const trackingNumber = typeof body.trackingNumber === "string" ? body.trackingNumber.trim() : "";
  // Same allow-list as public.orders' own carrier CHECK constraint (see
  // 20260821000000_order_shipping_address_and_carrier.sql) -- re-validated
  // here rather than trusted from the client, same "never trust the browser
  // for anything written to the DB" reasoning as trackingNumber's own
  // required check just below it.
  const ALLOWED_CARRIERS = ["colissimo", "chronopost", "mondial_relay", "autre"];
  const carrier = typeof body.carrier === "string" ? body.carrier.trim() : "";
  if (!orderId || !trackingNumber || !ALLOWED_CARRIERS.includes(carrier)) {
    return json(400, { error: "orderId, trackingNumber, and a valid carrier are required." });
  }
  // Only required/stored for "autre" -- same "never trust the browser"
  // re-validation as carrier/trackingNumber above (js/admin.js's own
  // shipConfirmBtn handler already requires this client-side, but that's
  // only ever a UX convenience, not the real gate). Forced to "" (not
  // whatever the client sent) for every other carrier, so a stale value
  // from an earlier "autre" submission can never linger onto a later
  // correction that switched to a real carrier.
  const carrierOtherName = carrier === "autre" && typeof body.carrierOtherName === "string" ? body.carrierOtherName.trim() : "";
  if (carrier === "autre" && !carrierOtherName) {
    return json(400, { error: "carrierOtherName is required when carrier is \"autre\"." });
  }

  const { data: order, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("id, reference_number, product_name, quantity, total, user_id, guest_email, shipping_status, tracking_number, carrier, carrier_other_name, language, shipping_postal_code")
    .eq("id", orderId)
    .maybeSingle();
  if (orderError || !order) {
    return json(404, { error: "Order not found." });
  }

  const wasAlreadyShipped = order.shipping_status === "shipped";
  // The number, the carrier, OR (for "autre") the typed carrier name
  // changing all count as a real correction -- the same number under a
  // different carrier (or a different name for the same "autre" carrier)
  // still tells the customer something different about their shipment than
  // what they were already told, so it needs the same apologetic re-send as
  // the tracking number itself changing.
  const trackingChanged = order.tracking_number !== trackingNumber
    || order.carrier !== carrier
    || (order.carrier_other_name || "") !== carrierOtherName;
  // First time -> normal shipping notification. Already shipped but
  // something actually changed -> the apologetic correction email instead.
  // Any other case (already shipped, same everything re-submitted -- e.g.
  // an accidental double confirm in the admin UI) -> nothing changed, so
  // nothing to email about; still returns success below, just silently.
  const isCorrection = wasAlreadyShipped && trackingChanged;
  const shouldSendEmail = !wasAlreadyShipped || trackingChanged;

  const { error: updateError } = await supabaseAdmin
    .from("orders")
    .update({
      shipping_status: "shipped",
      tracking_number: trackingNumber,
      carrier,
      // "" (from carrierOtherName's own derivation above) normalized to
      // null for storage -- matches every other optional text column on
      // this table (shipping_address_line2 etc.), never an empty string.
      carrier_other_name: carrierOtherName || null,
      // Reset on every real change (not just the first) -- a correction is
      // its own send attempt with its own success/failure to track, same
      // "false until a confirmed Resend accept" reasoning as email_sent
      // itself (see the migration that added this column).
      ...(shouldSendEmail ? { shipping_email_sent: false } : {}),
    })
    .eq("id", orderId);
  if (updateError) {
    console.error("mark-order-shipped: order update failed:", updateError.message);
    return json(500, { error: updateError.message });
  }

  if (shouldSendEmail) {
    // Never lets a Resend failure turn this into a non-2xx response -- the
    // shipping_status/tracking_number update above already committed, and
    // that's the fact that actually matters; a failed notification email is
    // logged + left as shipping_email_sent: false for later follow-up, same
    // as the confirmation email's own graceful-degradation design.
    await sendShippingEmail(supabaseAdmin, order, trackingNumber, carrier, carrierOtherName, isCorrection);
  }

  return json(200, { ok: true, isCorrection, emailSent: shouldSendEmail });
});

interface OrderRow {
  id: string;
  reference_number: string | null;
  product_name: string;
  quantity: number;
  total: number;
  user_id: string | null;
  guest_email: string | null;
  language: string | null;
  // Needed for Mondial Relay's own tracking link specifically -- see
  // carrierTrackingUrl()'s own comment on why that carrier's tracking page
  // requires the RECIPIENT's postal code alongside the tracking number,
  // unlike Colissimo/Chronopost. Already persisted on this row by
  // stripe-webhook at order-paid time (20260821000000_order_shipping_
  // address_and_carrier.sql) -- read here, not re-typed by the admin.
  shipping_postal_code: string | null;
}

async function resolveCustomerEmailAndName(
  supabaseAdmin: ReturnType<typeof createClient>,
  order: OrderRow,
): Promise<{ email: string | null; firstName: string }> {
  if (order.user_id) {
    const [{ data: profile }, { data: authUser, error: authError }] = await Promise.all([
      supabaseAdmin.from("profiles").select("first_name").eq("id", order.user_id).maybeSingle(),
      supabaseAdmin.auth.admin.getUserById(order.user_id),
    ]);
    if (authError) {
      console.error("mark-order-shipped: auth.admin.getUserById failed:", authError.message);
    }
    return { email: authUser?.user?.email || null, firstName: profile?.first_name || "" };
  }
  if (order.guest_email) {
    // No name stored anywhere for a guest order (see the migration's own
    // comment on why the shipping address -- the one place a name briefly
    // passed through -- was deliberately never persisted) -- greeting falls
    // back to the generic form, same as the confirmation email's own
    // extractFirstName() does when it has nothing safe to use.
    return { email: order.guest_email, firstName: "" };
  }
  return { email: null, firstName: "" };
}

async function sendShippingEmail(
  supabaseAdmin: ReturnType<typeof createClient>,
  order: OrderRow,
  trackingNumber: string,
  carrier: string,
  carrierOtherName: string,
  isCorrection: boolean,
) {
  const { email, firstName } = await resolveCustomerEmailAndName(supabaseAdmin, order);
  if (!email) {
    console.error("mark-order-shipped: no resolvable email for order", order.id, "-- notification skipped.");
    return;
  }
  if (!RESEND_API_KEY) {
    console.error("mark-order-shipped: RESEND_API_KEY is not configured -- skipping notification for order", order.id);
    return;
  }

  const language: "fr" | "en" = order.language === "en" ? "en" : "fr"; // matches js/i18n.js's own DEFAULT_LANG = 'fr'
  const { subject, html, text } = buildShippingEmail({
    language,
    firstName,
    referenceNumber: order.reference_number || "",
    productName: order.product_name,
    trackingNumber,
    carrier,
    carrierOtherName,
    postalCode: order.shipping_postal_code || "",
    isCorrection,
  });

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
    const { error: flagError } = await supabaseAdmin.from("orders").update({ shipping_email_sent: true }).eq("id", order.id);
    if (flagError) {
      console.error("mark-order-shipped: email sent but failed to set shipping_email_sent for order", order.id, ":", flagError.message);
    }
  } catch (err) {
    console.error("mark-order-shipped: notification email failed for order", order.id, ":", err instanceof Error ? err.message : err);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface ShippingEmailDetails {
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
function carrierTrackingUrl(carrier: string, trackingNumber: string, postalCode: string): string | null {
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
function buildShippingEmail(details: ShippingEmailDetails): { subject: string; html: string; text: string } {
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
  const legalFooterHtml = `<a href="${WEBSITE_URL}" style="color:#8f887c;">Effluve Paris</a> — <a href="${WEBSITE_URL}/cgv.html" style="color:#8f887c;">${termsLabel}</a> · <a href="${WEBSITE_URL}/confidentialite.html" style="color:#8f887c;">${privacyLabel}</a>`;
  const legalFooterText = `Effluve Paris (${WEBSITE_URL}) — ${termsLabel}: ${WEBSITE_URL}/cgv.html — ${privacyLabel}: ${WEBSITE_URL}/confidentialite.html`;

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
                      <p style="margin:0 0 10px;font-size:15px;font-weight:600;line-height:1.35;color:#d8b27c;">${productNameNatural} | ${ref}</p>
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
