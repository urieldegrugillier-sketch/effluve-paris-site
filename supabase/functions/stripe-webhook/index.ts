// MONARK — Stripe webhook: the authoritative, server-side source of truth
// for order completion. Previously the ONLY thing that ever wrote a
// public.orders row was js/account.js's recordOrder(), called client-side
// right after Stripe confirms payment in the browser -- if that tab closed,
// the network dropped, or the JS simply threw before that call ran, the
// payment still went through (Stripe already has the money) but no order
// record would ever exist. This function is the fix: Stripe calls it
// directly, server-to-server, whenever a PaymentIntent actually succeeds,
// completely independent of whether the customer's own browser is still
// around to tell anyone.
//
// ============================================================================
// ONE MANUAL SETUP STEP THIS ENVIRONMENT CAN'T DO FOR YOU (Stripe Dashboard):
//
// 1. Deploy this function first (`supabase functions deploy stripe-webhook
//    --linked`) so step 2 has a real URL to point at.
// 2. Stripe Dashboard -> Developers -> Webhooks -> "Add endpoint".
//    Endpoint URL (this project's ref, from js/supabase-client.js's own
//    SUPABASE_URL, is kqpekwaoklqlrdpdlqbx):
//      https://kqpekwaoklqlrdpdlqbx.supabase.co/functions/v1/stripe-webhook
// 3. "Select events to listen to" -> choose payment_intent.succeeded
//    specifically, not "all events" -- this function ignores every other
//    event type anyway (see the check below), but a narrower subscription
//    means less noise in the Dashboard's own delivery log/retry history.
// 4. After creating the endpoint, Stripe reveals a "Signing secret"
//    (starts with whsec_...) -- copy it.
// 5. Set it as a Supabase secret -- NEVER hardcode it here or commit it:
//      supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_... --linked
//    (or Supabase Dashboard -> Edge Functions -> stripe-webhook -> Secrets).
//    Read below via Deno.env.get("STRIPE_WEBHOOK_SECRET") -- without it set,
//    every incoming webhook fails signature verification and this function
//    responds 500 (see the config check below), which just means Stripe
//    keeps retrying deliveries with backoff until it's actually set.
// 6. (Order-confirmation email, separate from the five steps above) Set a
//    Resend API key with sending access for the effluve-paris.fr domain:
//      supabase secrets set RESEND_API_KEY=re_... --linked
//    Unlike the five steps above, this one is NOT required for order
//    reconciliation itself -- without it, orders still get marked 'paid'
//    exactly the same, they just never get a confirmation email (see
//    sendConfirmationEmail()'s own check + orders.email_sent, which stays
//    false in that case).
//
// Until all five (order-reconciliation) steps are done, Stripe has nowhere to send these events, so
// this function is simply never invoked -- checkout keeps working exactly as
// it does today (js/account.js's own recordOrder() still fires client-side,
// see that function's own comment on why it stays in place regardless), it
// just won't get the server-side 'paid' status + reference number until this
// is wired up.
// ============================================================================
//
// auth: none of this project's usual withSupabase()/verify_jwt machinery --
// Stripe's own servers call this directly, with no Supabase apikey/JWT at
// all (see supabase/config.toml's own verify_jwt = false for this function).
// Trust instead comes entirely from Stripe's signature on the raw request
// body, verified below against STRIPE_WEBHOOK_SECRET -- the one and only
// gate on this endpoint.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// Deliberately NOT in the required-config check below (unlike the four
// above) -- a missing/invalid Resend key must never stop an order from
// being marked 'paid' (Stripe already has the money, see reconcileOrder's
// own comment), only skip the confirmation email. sendConfirmationEmail()
// logs loudly and leaves orders.email_sent false when this is missing.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// contact@ on effluve-paris.fr -- the domain verified in Resend (SPF/DKIM);
// sending "from" any other domain would get the message rejected by Resend
// outright, not just marked spam. contact@ specifically (not commandes@,
// used originally) because it's the address actually wired up in Cloudflare
// Email Routing to forward replies to the real inbox -- commandes@ had no
// such forwarding rule, so a customer reply to it would have gone nowhere.
const FROM_ADDRESS = "Effluve Paris <contact@effluve-paris.fr>";
const CONTACT_EMAIL = "contact@effluve-paris.fr";
// Same api.whatsapp.com format (not wa.me) as checkout.html/contact.html's
// own whatsappHref -- see those files' own comments on why: more reliable
// than wa.me at carrying the ?text= prefill through the mobile OS's
// wa.me -> WhatsApp app hand-off.
const WHATSAPP_PHONE = "33605893897";
const WEBSITE_URL = "https://effluve-paris.fr";
// PNG (not the site's own assets/icons/effluve-word-dark-bg.svg) -- Outlook
// desktop's rendering engine (Word, not a real browser engine) has no SVG
// support at all, so a raster export is the only format guaranteed to
// display across mail clients; Gmail/Apple Mail/etc. would have been fine
// with the SVG, but Outlook wouldn't. Must be an absolute, publicly
// reachable URL -- email images are always linked, never inline data: URIs
// (most clients' spam filters penalize inline-embedded images heavily).
const LOGO_URL = `${WEBSITE_URL}/assets/icons/effluve-word-dark-bg.png`;
// Same PNG-not-SVG reasoning as LOGO_URL above -- css/style.css's own
// .nav-logo stacks these two images (EFFLUVE + PARIS) via flex-column, which
// email HTML has no equivalent of; buildConfirmationEmail() reproduces the
// same visual relationship (PARIS centered beneath EFFLUVE, smaller, bronze)
// with a plain table instead. See that file's own .nav-logo-subword comment
// for where the 0.349 height ratio and 0.16 gap ratio (both reused below)
// come from.
const PARIS_LOGO_URL = `${WEBSITE_URL}/assets/icons/paris-word-dark-bg.png`;
// Same PNG-not-source-format reasoning as LOGO_URL/PARIS_LOGO_URL above --
// the source (assets/images/02_fully_edited.webp, already this project's
// established small-thumbnail crop: js/cart.js's own PRODUCT.image, reused
// by cart-widget.js/checkout.html's own thumbnails) is WebP, which has the
// same inconsistent-across-clients support problem SVG does for email.
// email-product-thumb.png is a plain raster export at a fixed 400x400,
// generated the same headless-screenshot way as the two logo PNGs.
const PRODUCT_THUMB_URL = `${WEBSITE_URL}/assets/images/email-product-thumb.png`;
// "See our fragrances" points at the shop page specifically, not the
// homepage LOGO_URL above still points to -- a customer who already has a
// confirmed order doesn't need another pitch for the brand in general, but
// might well want to look at (or reorder) the product itself.
const PRODUCT_URL = `${WEBSITE_URL}/product.html`;
// Same figures as checkout.html's own SHIPPING_FEE/VAT_RATE consts --
// display-only "waived fee" lines, duplicated here (not imported) since
// Deno Edge Functions and this static site share no build step to import
// across. Keep in sync by hand if either ever changes on the checkout page.
const SHIPPING_FEE = 5.9;
const VAT_RATE = 0.2;

// Matches js/cart.js's own single hardcoded PRODUCT.name -- this project's
// one current MONARK edition. Only ever used as a fallback (see
// reconcileOrder() below) for the rare case this function has to build a
// complete order row from scratch, with no client-side recordOrder() row to
// reconcile onto.
const DEFAULT_PRODUCT_NAME = "MONARK Eau de Parfum | 100ml";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("stripe-webhook: missing required environment configuration (see this file's own setup comment).");
    return new Response("Not configured.", { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing Stripe-Signature header.", { status: 400 });
  }

  // MUST be the raw, unparsed request body -- Stripe's signature is computed
  // over the exact bytes it sent; parsing to JSON and re-serializing (even
  // losslessly) is not guaranteed byte-identical and would break
  // verification.
  const rawBody = await req.text();

  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
  // constructEventAsync (not the sync constructEvent) plus an explicit
  // SubtleCrypto-backed provider -- Deno's edge runtime has no Node `crypto`
  // module, which Stripe's default synchronous signature verification
  // depends on. This is Stripe's own documented approach for Deno/edge
  // runtimes (Supabase Edge Functions included).
  const cryptoProvider = Stripe.createSubtleCryptoProvider();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, STRIPE_WEBHOOK_SECRET, undefined, cryptoProvider);
  } catch (err) {
    // Wrong/missing signing secret, a tampered payload, or a request that
    // isn't really from Stripe at all -- reject outright, never process an
    // unverified event body.
    console.error("stripe-webhook: signature verification failed:", err instanceof Error ? err.message : err);
    return new Response("Invalid signature.", { status: 400 });
  }

  // create-checkout-session builds a raw PaymentIntent directly (no Stripe
  // Checkout Session involved) -- payment_intent.succeeded is the event
  // that actually corresponds to a completed order in this integration, not
  // checkout.session.completed (there is no Session object here at all).
  if (event.type !== "payment_intent.succeeded") {
    // Acknowledged (200), not an error -- if the Dashboard endpoint is ever
    // switched to "all events" instead of just this one, Stripe shouldn't
    // keep retrying deliveries this function deliberately doesn't act on.
    return new Response("Ignored (not payment_intent.succeeded).", { status: 200 });
  }

  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    await reconcileOrder(supabaseAdmin, paymentIntent);
    return new Response("OK", { status: 200 });
  } catch (err) {
    // A real DB error here (not a duplicate -- see reconcileOrder()'s own
    // 23505 handling below) is worth a retry: a non-2xx response makes
    // Stripe's own retry schedule try this delivery again later, rather
    // than silently dropping a confirmed payment's order record.
    console.error("stripe-webhook: order reconciliation failed:", err instanceof Error ? err.message : err);
    return new Response("Internal error.", { status: 500 });
  }
});

// Idempotent by design: safe to run more than once for the exact same
// PaymentIntent (Stripe's own retry policy means every webhook consumer has
// to tolerate at-least-once delivery, never exactly-once) and safe to race
// against js/account.js's own client-side recordOrder() insert for that same
// PaymentIntent -- whichever side's INSERT lands first wins the row,
// whichever side loses that race falls back to an UPDATE onto the winner's
// row instead of ever creating a duplicate order.
async function reconcileOrder(
  supabaseAdmin: ReturnType<typeof createClient>,
  paymentIntent: Stripe.PaymentIntent,
) {
  const metadata = paymentIntent.metadata || {};

  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("orders")
    .select("id, status, reference_number, product_name, quantity, total, guest_email, user_id, created_at")
    .eq("payment_intent_id", paymentIntent.id)
    .maybeSingle();
  if (lookupError) throw lookupError;

  if (existing) {
    if (existing.status === "paid") return; // already reconciled -- Stripe redelivering the same event, a safe no-op (also why the confirmation email never double-sends on retries)
    let referenceNumber: string;
    if (existing.reference_number) {
      referenceNumber = existing.reference_number;
      const { error: updateError } = await supabaseAdmin.from("orders").update({ status: "paid" }).eq("id", existing.id);
      if (updateError) throw updateError;
    } else {
      referenceNumber = await updateOrderWithFreshReference(supabaseAdmin, existing.id, { status: "paid" });
    }
    // Order status is now durably 'paid' regardless of what happens below --
    // sendConfirmationEmail() never throws, so a Resend outage/misconfig
    // can't turn this into a 500 that makes Stripe retry an already-settled
    // reconciliation.
    await sendOrderConfirmation(supabaseAdmin, metadata, existing.id, {
      referenceNumber,
      productName: existing.product_name,
      quantity: existing.quantity,
      total: existing.total,
      guestEmail: existing.guest_email,
      userId: existing.user_id,
      createdAt: existing.created_at,
    });
    return;
  }

  // No row yet -- either this webhook genuinely arrived before
  // recordOrder()'s own client-side insert, or that insert never happened
  // at all. Build a complete row straight from the PaymentIntent: amount_received
  // is Stripe's own confirmed charge (the source of truth for `total` here,
  // not whatever the client last displayed), metadata carries
  // quantity/identity (see create-checkout-session's own comment on why
  // it's set there).
  const quantity = Math.max(1, Math.floor(Number(metadata.quantity)) || 1);
  const productName = (metadata.product_name as string) || DEFAULT_PRODUCT_NAME;
  const total = paymentIntent.amount_received / 100;
  const row: Record<string, unknown> = {
    payment_intent_id: paymentIntent.id,
    product_name: productName,
    quantity,
    total,
    status: "paid",
  };
  if (metadata.user_id) {
    row.user_id = metadata.user_id;
  } else if (metadata.guest_email) {
    row.guest_email = metadata.guest_email;
  } else {
    // No identity metadata at all -- shouldn't normally happen (see
    // create-checkout-session, which always sets one or the other before
    // Payment is ever reached), but a confirmed payment is never worth
    // silently dropping from the record over this. Inserted anyway as an
    // unattributed row; logged loudly so it's actually noticed rather than
    // quietly lost.
    console.error("stripe-webhook: PaymentIntent has no user_id/guest_email metadata -- inserting unattributed order.", paymentIntent.id);
  }

  // Random reference generated + attempted here inline (not via
  // updateOrderWithFreshReference, which only handles UPDATE) because an
  // INSERT can collide on EITHER of two different UNIQUE constraints --
  // reference_number (this order's own retry loop) or payment_intent_id (a
  // genuine race against another concurrent insert for the same
  // PaymentIntent, handled below exactly as before) -- and those two need
  // different responses (retry vs. fall through to race-winner handling).
  let referenceNumber = "";
  let inserted: { id: string; created_at: string } | null = null;
  let insertError: { code?: string; message?: string; details?: string } | null = null;
  for (let attempt = 1; attempt <= MAX_REFERENCE_ATTEMPTS; attempt++) {
    referenceNumber = generateReferenceCode();
    const { data, error } = await supabaseAdmin
      .from("orders")
      .insert({ ...row, reference_number: referenceNumber })
      .select("id, created_at")
      .single();
    if (!error) {
      inserted = data;
      insertError = null;
      break;
    }
    insertError = error;
    if (!isReferenceNumberConflict(error)) break; // a different error (e.g. payment_intent_id race) -- stop retrying, handled below
  }

  if (inserted) {
    await sendOrderConfirmation(supabaseAdmin, metadata, inserted.id, {
      referenceNumber,
      productName,
      quantity,
      total,
      guestEmail: (row.guest_email as string) || null,
      userId: (row.user_id as string) || null,
      createdAt: inserted.created_at,
    });
    return;
  }

  if (insertError && insertError.code === "23505" && !isReferenceNumberConflict(insertError)) {
    // Lost a race against another concurrent insert for this exact
    // PaymentIntent (recordOrder()'s own client-side call, or a second
    // near-simultaneous webhook delivery) -- that row now exists, so finish
    // the job by updating IT to 'paid' instead of erroring out.
    const { data: raceWinner, error: refetchError } = await supabaseAdmin
      .from("orders")
      .select("id, status, reference_number, product_name, quantity, total, guest_email, user_id, created_at")
      .eq("payment_intent_id", paymentIntent.id)
      .maybeSingle();
    if (refetchError) throw refetchError;
    if (raceWinner && raceWinner.status !== "paid") {
      let finalReference: string;
      if (raceWinner.reference_number) {
        finalReference = raceWinner.reference_number;
        const { error: updateError } = await supabaseAdmin.from("orders").update({ status: "paid" }).eq("id", raceWinner.id);
        if (updateError) throw updateError;
      } else {
        finalReference = await updateOrderWithFreshReference(supabaseAdmin, raceWinner.id, { status: "paid" });
      }
      await sendOrderConfirmation(supabaseAdmin, metadata, raceWinner.id, {
        referenceNumber: finalReference,
        productName: raceWinner.product_name,
        quantity: raceWinner.quantity,
        total: raceWinner.total,
        guestEmail: raceWinner.guest_email,
        userId: raceWinner.user_id,
        createdAt: raceWinner.created_at,
      });
    }
    return;
  }
  if (insertError) throw insertError;
  throw new Error("stripe-webhook: exhausted reference number retries during order insert");
}

// ============================================================================
// Order-confirmation email (Resend) -- fires once per order, right after the
// 'paid' status update actually commits (every call site above only reaches
// this line once its own update/insert succeeded). Resolving the recipient
// and sending are both best-effort: any failure is logged and swallowed here
// so it can never bubble up and turn an already-successful order write into
// a 500 (which would make Stripe retry a delivery whose only remaining
// effect would be a duplicate send attempt anyway, since existing.status ===
// "paid" short-circuits reconcileOrder() before this is ever reached again).
// ============================================================================

interface OrderConfirmationInput {
  referenceNumber: string;
  productName: string;
  quantity: number;
  total: number;
  guestEmail: string | null;
  userId: string | null;
  createdAt: string;
}

async function sendOrderConfirmation(
  supabaseAdmin: ReturnType<typeof createClient>,
  metadata: Record<string, string>,
  orderId: string,
  order: OrderConfirmationInput,
) {
  const email = await resolveCustomerEmail(supabaseAdmin, metadata, order);
  if (!email) {
    console.error("stripe-webhook: no resolvable email for order", orderId, "-- confirmation email skipped.");
    return;
  }
  const language = metadata.language === "en" ? "en" : "fr"; // matches js/i18n.js's own DEFAULT_LANG = 'fr'
  const { subtotal, discount } = await computePriceBreakdown(supabaseAdmin, order.quantity, order.total, metadata.promo_code || "");
  await sendConfirmationEmail(supabaseAdmin, orderId, {
    email,
    language,
    referenceNumber: order.referenceNumber,
    productName: order.productName,
    quantity: order.quantity,
    total: order.total,
    createdAt: order.createdAt,
    subtotal,
    discount,
    // Only shown when a positive discount was actually derivable (see
    // computePriceBreakdown) -- a promo_code metadata value with no
    // resolvable discount amount would otherwise print a code with no
    // corresponding deduction, which reads as a bug rather than a feature.
    promoCode: discount > 0 ? metadata.promo_code || "" : "",
    // Only ever present when create-checkout-session's own metadata carried
    // them (see that function's own comment) -- absent on any order whose
    // PaymentIntent predates this field, in which case the email simply
    // omits the shipping-address recap rather than showing a half-empty one.
    shippingName: metadata.shipping_name || "",
    shippingAddressLine1: metadata.shipping_address_line1 || "",
    shippingAddressLine2: metadata.shipping_address_line2 || "",
    shippingCity: metadata.shipping_city || "",
    shippingPostalCode: metadata.shipping_postal_code || "",
    shippingCountry: metadata.shipping_country || "",
  });
}

// Builds the Subtotal/Shipping/VAT/[Promo]/Total breakdown shown in the
// confirmation email, matching checkout.html's own summaryLinesHtml() as
// closely as the data available here allows. The webhook has no per-order
// record of the unit price actually charged (public.orders stores only the
// final `total`) -- subtotal is reconstructed from the CURRENT
// public.products price, same server-side source of truth
// create-checkout-session itself charges from. That's exact for the common
// case (this project has only ever had one product/price), but would drift
// if the price changes between an order and whenever this runs; a lookup
// failure, or a promo_code with no positive resulting discount (price drift,
// or metadata from a pre-this-feature order), falls back to subtotal ===
// total with no discount line -- never a fabricated number.
async function computePriceBreakdown(
  supabaseAdmin: ReturnType<typeof createClient>,
  quantity: number,
  total: number,
  promoCode: string,
): Promise<{ subtotal: number; discount: number }> {
  const { data: product, error } = await supabaseAdmin.from("products").select("price").limit(1).maybeSingle();
  if (error || !product) {
    console.error("stripe-webhook: product price lookup failed while building confirmation email price breakdown:", error?.message);
    return { subtotal: total, discount: 0 };
  }
  const rawSubtotal = Math.round(product.price * quantity * 100) / 100;
  if (promoCode && rawSubtotal > total) {
    return { subtotal: rawSubtotal, discount: Math.round((rawSubtotal - total) * 100) / 100 };
  }
  return { subtotal: total, discount: 0 };
}

// customer_email (set by create-checkout-session for both guest and
// logged-in sessions, see that function's own comment) covers the normal
// path. The two fallbacks below only matter for orders whose PaymentIntent
// predates this metadata field, or where it was somehow dropped:
// guest_email is already on the order row itself, and a logged-in user's
// email has to come from auth.users via the admin API (same reasoning as
// check-email-exists -- public.profiles has no email column at all).
async function resolveCustomerEmail(
  supabaseAdmin: ReturnType<typeof createClient>,
  metadata: Record<string, string>,
  order: { guestEmail: string | null; userId: string | null },
): Promise<string | null> {
  if (metadata.customer_email) return metadata.customer_email;
  if (order.guestEmail) return order.guestEmail;
  if (order.userId) {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(order.userId);
    if (error) {
      console.error("stripe-webhook: auth.admin.getUserById failed while resolving confirmation email:", error.message);
      return null;
    }
    return data?.user?.email || null;
  }
  return null;
}

interface ConfirmationEmailDetails {
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

async function sendConfirmationEmail(
  supabaseAdmin: ReturnType<typeof createClient>,
  orderId: string,
  details: ConfirmationEmailDetails,
) {
  if (!RESEND_API_KEY) {
    console.error("stripe-webhook: RESEND_API_KEY is not configured -- skipping confirmation email for order", orderId);
    return;
  }

  const { subject, html, text } = buildConfirmationEmail(details);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [details.email],
        subject,
        html,
        text,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Resend API responded ${res.status}: ${errBody}`);
    }
    // Only flipped to true on a confirmed Resend accept -- see the migration
    // that added this column for how a stuck `false` on a 'paid' order is
    // meant to be found/handled at this project's current order volume.
    const { error: flagError } = await supabaseAdmin.from("orders").update({ email_sent: true }).eq("id", orderId);
    if (flagError) {
      console.error("stripe-webhook: confirmation email sent but failed to set email_sent for order", orderId, ":", flagError.message);
    }
  } catch (err) {
    console.error("stripe-webhook: confirmation email failed for order", orderId, ":", err instanceof Error ? err.message : err);
  }
}

function formatMoney(n: number): string {
  // Matches checkout.html's own money() exactly (€ prefix, en-US grouping/
  // decimal formatting) so the amount in the email reads identically to what
  // the customer already saw on the confirmation screen.
  return "€" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(s: string): string {
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
function countryLabel(code: string, isFr: boolean): string {
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
function formatOrderDate(isoString: string, isFr: boolean): string {
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
function extractFirstName(fullName: string): string {
  const firstToken = fullName.trim().split(/\s+/)[0] || "";
  if (firstToken.length < 2 || !/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(firstToken)) return "";
  return firstToken;
}

function buildConfirmationEmail(details: ConfirmationEmailDetails): { subject: string; html: string; text: string } {
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

  // "|" not "—" -- matches the sitewide separator convention (e.g.
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
  const legalFooterHtml = `<a href="${WEBSITE_URL}" style="color:#8f887c;">Effluve Paris</a> — <a href="${WEBSITE_URL}/cgv.html" style="color:#8f887c;">${labels.terms}</a> · <a href="${WEBSITE_URL}/confidentialite.html" style="color:#8f887c;">${labels.privacy}</a>`;
  const legalFooterText = `Effluve Paris (${WEBSITE_URL}) — ${labels.terms}: ${WEBSITE_URL}/cgv.html — ${labels.privacy}: ${WEBSITE_URL}/confidentialite.html`;

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
                      <img src="${PRODUCT_THUMB_URL}" width="120" height="120" alt="${productName}" style="display:block;border:0;outline:none;width:120px;height:120px;border-radius:4px;">
                    </td>
                    <td valign="top">
                      <p style="margin:0 0 4px;font-size:15px;font-weight:600;line-height:1.35;color:#d8b27c;">${productNameNatural} | ${details.referenceNumber}</p>
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

// 8-char alphanumeric, uppercase letters + digits, excluding ambiguous
// glyphs (O/0, I/1, L) -- readable over a phone call or in a support email.
// No "EP-YYYY-" prefix (the old sequential format -- see the migration that
// dropped generate_order_reference()/order_reference_seq -- let a customer
// infer order volume from their own reference number, e.g. "EP-2026-0042"
// reads as "the 42nd order this year"). 31 characters ^ 8 length is ample
// headroom at this project's order volume for updateOrderWithFreshReference/
// reconcileOrder's own insert loop to essentially never exhaust
// MAX_REFERENCE_ATTEMPTS in practice.
const REFERENCE_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const REFERENCE_LENGTH = 8;
const MAX_REFERENCE_ATTEMPTS = 8;

function generateReferenceCode(): string {
  let code = "";
  for (let i = 0; i < REFERENCE_LENGTH; i++) {
    code += REFERENCE_CHARSET[Math.floor(Math.random() * REFERENCE_CHARSET.length)];
  }
  return code;
}

// A random code (unlike the old sequence) has no atomic "next value" --
// collision-safety comes entirely from the UPDATE/INSERT itself failing
// against orders.reference_number's existing UNIQUE constraint and the
// caller retrying with a fresh code. Postgres's own error message/details
// both name the offending column, so a substring check is enough to tell a
// reference_number collision apart from any other 23505 (e.g.
// payment_intent_id's, handled separately) without parsing the constraint
// name precisely.
function isReferenceNumberConflict(error: { code?: string; message?: string; details?: string } | null | undefined): boolean {
  if (!error || error.code !== "23505") return false;
  return `${error.message || ""} ${error.details || ""}`.includes("reference_number");
}

// Shared by reconcileOrder()'s two UPDATE-based paths (existing row / race
// winner) -- generates a fresh code, attempts the update, and retries with a
// new code on a reference_number collision specifically. Any other error is
// rethrown immediately for the caller's own handling.
async function updateOrderWithFreshReference(
  supabaseAdmin: ReturnType<typeof createClient>,
  orderId: string,
  extraFields: Record<string, unknown>,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_REFERENCE_ATTEMPTS; attempt++) {
    const referenceNumber = generateReferenceCode();
    const { error } = await supabaseAdmin
      .from("orders")
      .update({ ...extraFields, reference_number: referenceNumber })
      .eq("id", orderId);
    if (!error) return referenceNumber;
    if (!isReferenceNumberConflict(error)) throw error;
    lastError = error;
  }
  throw lastError instanceof Error ? lastError : new Error("stripe-webhook: exhausted reference number retries");
}
