// MONARK: Stripe webhook: the authoritative, server-side source of truth
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
// 7. (Telegram order ping, also separate from the five steps above and
//    independent of step 6) See sendTelegramOrderNotification()'s own
//    comment, right above that function further down this file, for the
//    full walkthrough (create a bot via @BotFather, get its token, get your
//    chat_id via getUpdates) -- also not required for order reconciliation
//    itself, silently skipped without it.
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
// Email builders and their constants live in ./email.ts (pure, importable;
// also used by scripts/send-test-emails.mjs for local previews).
import {
  FROM_ADDRESS,
  INTERNAL_NOTIFICATION_EMAIL,
  ADMIN_URL,
  buildInternalOrderNotificationEmail,
  type ConfirmationEmailDetails,
  formatMoney,
  escapeHtml,
  buildConfirmationEmail,
} from "./email.ts";

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
// Same "deliberately NOT in the required-config check" reasoning as
// RESEND_API_KEY just above -- a missing/invalid Telegram bot token or chat
// id must never stop an order from being marked 'paid' either, only skip
// the Telegram notification. sendTelegramOrderNotification() logs loudly
// when either is missing, same as every other best-effort notification in
// this file. See that function's own comment for what a project owner
// needs to do (via @BotFather + one manual message + getUpdates) to obtain
// real values for these two -- neither is guessable/derivable from
// anything else, both have to be set by hand:
//   supabase secrets set TELEGRAM_BOT_TOKEN=123456:ABC-... --linked
//   supabase secrets set TELEGRAM_CHAT_ID=123456789 --linked
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");
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
// public.orders never persisted the shipping address at all before this --
// it only ever existed on the PaymentIntent's own metadata (see
// create-checkout-session's own comment on why it's sent there), read once
// by sendOrderConfirmation() below for the confirmation email's address
// recap, then gone. admin.html's Orders tab needs it to survive past that
// one read (see 20260821000000_order_shipping_address_and_carrier.sql's own
// comment) -- this is the one place it's actually written, at each of
// reconcileOrder()'s three call sites below, the same conditional
// "only set what metadata actually carries" pattern already used for
// `language` just below each of these.
function shippingFieldsFromMetadata(metadata: Record<string, string>): Record<string, string> {
  const fields: Record<string, string> = {};
  if (metadata.shipping_name) fields.shipping_name = metadata.shipping_name;
  if (metadata.shipping_address_line1) fields.shipping_address_line1 = metadata.shipping_address_line1;
  if (metadata.shipping_address_line2) fields.shipping_address_line2 = metadata.shipping_address_line2;
  if (metadata.shipping_city) fields.shipping_city = metadata.shipping_city;
  if (metadata.shipping_postal_code) fields.shipping_postal_code = metadata.shipping_postal_code;
  if (metadata.shipping_country) fields.shipping_country = metadata.shipping_country;
  return fields;
}

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
    // Persisted here (not just read from metadata at send time) so the
    // shipping-notification email -- sent much later, from an admin action
    // with no PaymentIntent metadata available at all -- can still honor
    // the customer's original language. See the migration that added this
    // column for why (unlike e.g. the shipping address) this one has to
    // survive past this function's own run.
    const orderLanguage = metadata.language === "en" || metadata.language === "fr" ? metadata.language : undefined;
    let referenceNumber: string;
    if (existing.reference_number) {
      referenceNumber = existing.reference_number;
      const { error: updateError } = await supabaseAdmin
        .from("orders")
        .update({ status: "paid", ...shippingFieldsFromMetadata(metadata), ...(orderLanguage ? { language: orderLanguage } : {}) })
        .eq("id", existing.id);
      if (updateError) throw updateError;
    } else {
      referenceNumber = await updateOrderWithFreshReference(supabaseAdmin, existing.id, {
        status: "paid",
        ...shippingFieldsFromMetadata(metadata),
        ...(orderLanguage ? { language: orderLanguage } : {}),
      });
    }
    // Order status is now durably 'paid' regardless of what happens below --
    // sendConfirmationEmail() never throws, so a Resend outage/misconfig
    // can't turn this into a 500 that makes Stripe retry an already-settled
    // reconciliation. incrementPromoCodeUsage()/decrementProductStock()
    // carry the same never-throw guarantee for the same reason -- see each
    // function's own comment.
    await incrementPromoCodeUsage(supabaseAdmin, metadata.promo_code || "");
    await decrementProductStock(supabaseAdmin, existing.quantity);
    await sendOrderConfirmation(supabaseAdmin, metadata, existing.id, {
      referenceNumber,
      productName: existing.product_name,
      quantity: existing.quantity,
      total: existing.total,
      guestEmail: existing.guest_email,
      userId: existing.user_id,
      createdAt: existing.created_at,
    });
    await sendInternalOrderNotification(supabaseAdmin, paymentIntent, existing.id, {
      referenceNumber,
      productName: existing.product_name,
      quantity: existing.quantity,
      total: existing.total,
      guestEmail: existing.guest_email,
      userId: existing.user_id,
      createdAt: existing.created_at,
    });
    await sendTelegramOrderNotification(existing.id, {
      referenceNumber,
      productName: existing.product_name,
      quantity: existing.quantity,
      total: existing.total,
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
    ...shippingFieldsFromMetadata(metadata),
  };
  if (metadata.language === "en" || metadata.language === "fr") row.language = metadata.language;
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
    await incrementPromoCodeUsage(supabaseAdmin, metadata.promo_code || "");
    await decrementProductStock(supabaseAdmin, quantity);
    await sendOrderConfirmation(supabaseAdmin, metadata, inserted.id, {
      referenceNumber,
      productName,
      quantity,
      total,
      guestEmail: (row.guest_email as string) || null,
      userId: (row.user_id as string) || null,
      createdAt: inserted.created_at,
    });
    await sendInternalOrderNotification(supabaseAdmin, paymentIntent, inserted.id, {
      referenceNumber,
      productName,
      quantity,
      total,
      guestEmail: (row.guest_email as string) || null,
      userId: (row.user_id as string) || null,
      createdAt: inserted.created_at,
    });
    await sendTelegramOrderNotification(inserted.id, { referenceNumber, productName, quantity, total });
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
      const raceLanguage = metadata.language === "en" || metadata.language === "fr" ? metadata.language : undefined;
      let finalReference: string;
      if (raceWinner.reference_number) {
        finalReference = raceWinner.reference_number;
        const { error: updateError } = await supabaseAdmin
          .from("orders")
          .update({ status: "paid", ...shippingFieldsFromMetadata(metadata), ...(raceLanguage ? { language: raceLanguage } : {}) })
          .eq("id", raceWinner.id);
        if (updateError) throw updateError;
      } else {
        finalReference = await updateOrderWithFreshReference(supabaseAdmin, raceWinner.id, {
          status: "paid",
          ...shippingFieldsFromMetadata(metadata),
          ...(raceLanguage ? { language: raceLanguage } : {}),
        });
      }
      await incrementPromoCodeUsage(supabaseAdmin, metadata.promo_code || "");
      await decrementProductStock(supabaseAdmin, raceWinner.quantity);
      await sendOrderConfirmation(supabaseAdmin, metadata, raceWinner.id, {
        referenceNumber: finalReference,
        productName: raceWinner.product_name,
        quantity: raceWinner.quantity,
        total: raceWinner.total,
        guestEmail: raceWinner.guest_email,
        userId: raceWinner.user_id,
        createdAt: raceWinner.created_at,
      });
      await sendInternalOrderNotification(supabaseAdmin, paymentIntent, raceWinner.id, {
        referenceNumber: finalReference,
        productName: raceWinner.product_name,
        quantity: raceWinner.quantity,
        total: raceWinner.total,
        guestEmail: raceWinner.guest_email,
        userId: raceWinner.user_id,
        createdAt: raceWinner.created_at,
      });
      await sendTelegramOrderNotification(raceWinner.id, {
        referenceNumber: finalReference,
        productName: raceWinner.product_name,
        quantity: raceWinner.quantity,
        total: raceWinner.total,
      });
    }
    return;
  }
  if (insertError) throw insertError;
  throw new Error("stripe-webhook: exhausted reference number retries during order insert");
}

// BUG FIX: promo_codes.times_used was never incremented anywhere (see
// 20260729120000_add_promo_codes_table.sql's own comment flagging this as a
// known gap at the time -- this webhook is the order-completion hook that
// comment said didn't exist yet). Called from the same three call sites as
// sendOrderConfirmation() below, each of which only runs the FIRST time a
// given order turns 'paid' (existing.status === "paid" short-circuits
// earlier for a redelivered webhook event, see reconcileOrder()'s own
// comment) -- so this increments exactly once per paid order, never on a
// Stripe retry. promo_code is read straight off the PaymentIntent's own
// metadata (create-checkout-session only ever sets it to a non-empty value
// once ITS OWN server-side validation approved the code for the actual
// charge, see that function's own comment) -- no need to re-validate
// active/expires_at/max_uses again here, and no reason to: the charge this
// order paid already reflects that code's discount, so counting it as "used"
// is correct regardless of whether the code has since been deactivated or
// expired. The increment itself is done by a SECURITY DEFINER SQL function
// (public.increment_promo_code_usage, see its own migration) rather than a
// read-then-write from here, so two orders redeeming the same code near-
// simultaneously can't race each other into under-counting. Never throws --
// same reasoning as sendConfirmationEmail() below: a promo-counter glitch
// must never turn an already-settled 'paid' order into a Stripe-retried 500.
async function incrementPromoCodeUsage(
  supabaseAdmin: ReturnType<typeof createClient>,
  promoCode: string,
) {
  if (!promoCode) return; // no promo code applied to this order -- nothing to count
  const { error } = await supabaseAdmin.rpc("increment_promo_code_usage", { p_code: promoCode });
  if (error) {
    console.error("stripe-webhook: failed to increment promo_codes.times_used for", promoCode, ":", error.message);
  }
}

// public.products.stock_remaining was never decremented anywhere -- only
// ever moved by hand via admin.html's Stock tab (see
// 20260811000000_admin_stock_edit.sql). Called from the same three call
// sites as incrementPromoCodeUsage() just above, for the exact same
// "exactly once per order, the FIRST time it turns 'paid', never on a
// Stripe retry" reasoning -- see that function's own comment. Same atomic,
// SECURITY DEFINER SQL function pattern too (public.decrement_product_stock,
// see its own migration for the race-safety/floor-at-0 reasoning) rather
// than a read-then-write from here, for the same "two orders confirming
// near-simultaneously can't race each other" reason. Never throws -- a
// stock-counter glitch must never turn an already-settled 'paid' order into
// a Stripe-retried 500, same as every other best-effort side effect here.
async function decrementProductStock(
  supabaseAdmin: ReturnType<typeof createClient>,
  quantity: number,
) {
  const { data, error } = await supabaseAdmin.rpc("decrement_product_stock", { p_quantity: quantity });
  if (error) {
    console.error("stripe-webhook: failed to decrement products.stock_remaining by", quantity, ":", error.message);
    return;
  }
  // Purely informational -- logged so a run of orders that drains stock to
  // (or past, before the floor) 0 is actually visible in the function logs,
  // not silently invisible until someone happens to check admin.html's own
  // Stock tab. Nothing here blocks or alters the order/response either way
  // -- see this migration's own comment on why a "sold out" block is a
  // separate, unconfirmed product decision, not built here.
  if (typeof data === "number" && data <= 0) {
    console.error("stripe-webhook: products.stock_remaining is at or below 0 after this order (", data, ") -- consider restocking or confirming whether checkout should block once sold out.");
  }
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

// ============================================================================
// Internal order notification (Resend) -- a plain heads-up to the business's
// own inbox every time an order is actually paid, same trigger point/
// never-throw guarantee as sendOrderConfirmation() just above (best-effort,
// never turns an already-settled 'paid' order into a Stripe-retried 500).
// Kept deliberately simpler than the customer-facing email: one language
// (this always lands in the business owner's own inbox, never a customer's,
// so there's no reader whose language preference matters here), no CTA/
// reply/WhatsApp/legal footer (nothing for an internal reader to click
// through to) -- just the essentials: reference, product, total, who it's
// for, and where it's going.
// ============================================================================

interface InternalNotificationInput {
  referenceNumber: string;
  productName: string;
  quantity: number;
  total: number;
  guestEmail: string | null;
  userId: string | null;
  createdAt: string;
}

// "Visa •••• 4242": card brand + last 4 digits only, nothing else from the
// PaymentMethod. Best-effort: any Stripe error just yields "" (the email
// then says "Non renseigné"), never blocks the notification.
async function paymentMethodSummary(paymentIntent: Stripe.PaymentIntent): Promise<string> {
  const pm = paymentIntent.payment_method;
  if (!pm || !STRIPE_SECRET_KEY) return "";
  try {
    const method = typeof pm === "string"
      ? await new Stripe(STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() }).paymentMethods.retrieve(pm)
      : pm;
    const card = method.card;
    if (!card) return method.type || "";
    const brand = card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : "Carte";
    return card.last4 ? `${brand} •••• ${card.last4}` : brand;
  } catch (err) {
    console.error("stripe-webhook: could not read payment method for the internal notification:", err instanceof Error ? err.message : err);
    return "";
  }
}

// Shipping step phone (metadata.shipping_phone, sent by create-checkout-
// session), falling back to the account's own phone for a logged-in
// customer. "" when neither exists. Best-effort, never throws.
async function resolveCustomerPhone(
  supabaseAdmin: ReturnType<typeof createClient>,
  metadata: Record<string, string>,
  userId: string | null,
): Promise<string> {
  if (metadata.shipping_phone) return metadata.shipping_phone;
  if (!userId) return "";
  const { data, error } = await supabaseAdmin.from("profiles").select("phone, dial_code").eq("id", userId).maybeSingle();
  const profile = data as { phone?: string | null; dial_code?: string | null } | null;
  if (error || !profile || !profile.phone) return "";
  return profile.dial_code ? `+${profile.dial_code} ${profile.phone}` : String(profile.phone);
}

async function sendInternalOrderNotification(
  supabaseAdmin: ReturnType<typeof createClient>,
  paymentIntent: Stripe.PaymentIntent,
  orderId: string,
  order: InternalNotificationInput,
) {
  const metadata = paymentIntent.metadata || {};
  if (!RESEND_API_KEY) {
    console.error("stripe-webhook: RESEND_API_KEY is not configured -- skipping internal order notification for order", orderId);
    return;
  }
  // Same resolution as sendOrderConfirmation()'s own resolveCustomerEmail()
  // call just above -- a second, independent call rather than threading the
  // first call's result through, so this stays fully isolated from that
  // function's own code path (never modifies it, never depends on it
  // having run first or succeeded).
  const customerEmail = await resolveCustomerEmail(supabaseAdmin, metadata, order);
  const promoCode = metadata.promo_code || "";
  const { subtotal, discount, unitPrice } = await computePriceBreakdown(supabaseAdmin, order.quantity, order.total, promoCode);
  const { subject, html, text } = buildInternalOrderNotificationEmail({
    referenceNumber: order.referenceNumber,
    createdAt: order.createdAt || new Date().toISOString(),
    productName: order.productName,
    quantity: order.quantity,
    unitPrice,
    subtotal,
    discount,
    promoCode,
    total: order.total,
    customerEmail: customerEmail || "",
    customerPhone: await resolveCustomerPhone(supabaseAdmin, metadata, order.userId),
    isGuest: !order.userId,
    customerLanguage: metadata.language === "en" ? "en" : "fr",
    paymentMethod: await paymentMethodSummary(paymentIntent),
    // Same metadata fields shippingFieldsFromMetadata() persists onto the
    // row -- read directly here rather than re-fetched from the row, same
    // "already have it in hand at this exact synchronous point" reasoning
    // as sendOrderConfirmation()'s own shippingName/etc. just above.
    shippingName: metadata.shipping_name || "",
    shippingAddressLine1: metadata.shipping_address_line1 || "",
    shippingAddressLine2: metadata.shipping_address_line2 || "",
    shippingCity: metadata.shipping_city || "",
    shippingPostalCode: metadata.shipping_postal_code || "",
    shippingCountry: metadata.shipping_country || "",
  });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [INTERNAL_NOTIFICATION_EMAIL], subject, html, text }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Resend API responded ${res.status}: ${errBody}`);
    }
    // No email_sent-style column/retry tracking for this one, unlike the
    // customer-facing emails (orders.email_sent/shipping_email_sent) -- this
    // is a best-effort internal heads-up, not something a customer is ever
    // left waiting on; a lost delivery here just means checking admin.html's
    // own Orders tab instead, which already has the full picture regardless.
  } catch (err) {
    console.error("stripe-webhook: internal order notification failed for order", orderId, ":", err instanceof Error ? err.message : err);
  }
}

// ============================================================================
// Telegram order notification -- a quick real-time ping (not the fuller
// Gmail heads-up sendInternalOrderNotification() above already covers) for
// whichever chat TELEGRAM_CHAT_ID points at. Same trigger points, same
// never-throw guarantee as every other post-payment notification in this
// file. Deliberately narrower content than the internal email -- reference,
// item, total only, no customer email/shipping address (Telegram is the
// "glance at your phone" channel; admin.html's Orders tab or the internal
// email already have the full picture for anything needing follow-up).
//
// SETUP -- three things a project owner has to do by hand, none of which
// are guessable/creatable from here:
//   1. Create the bot: message @BotFather on Telegram, send /newbot, follow
//      its prompts (choose a name + a username ending in "bot"). It replies
//      with a token shaped like "123456789:AAExampleTokenTextGoesHere" --
//      that's TELEGRAM_BOT_TOKEN.
//   2. Get the chat_id: start a conversation with your OWN new bot (search
//      its username, hit Start, send it any message -- e.g. "hi") so it has
//      something to read back, then visit
//      https://api.telegram.org/bot<TOKEN>/getUpdates in a browser (with
//      your real token in place of <TOKEN>). The JSON response contains
//      your message under result[0].message.chat.id -- that number (can be
//      negative for a group chat) is TELEGRAM_CHAT_ID. If the response is
//      empty ({"ok":true,"result":[]}), the bot hasn't received a message
//      yet -- send it one first, then reload that URL.
//   3. Set both as Supabase secrets (never hardcoded here or committed):
//        supabase secrets set TELEGRAM_BOT_TOKEN=123456789:AAExample... --linked
//        supabase secrets set TELEGRAM_CHAT_ID=123456789 --linked
// Until both are set, this silently no-ops (logged once per order, see
// below) -- order reconciliation itself is entirely unaffected either way,
// same as a missing RESEND_API_KEY only ever skipping email.
// ============================================================================

interface TelegramNotificationInput {
  referenceNumber: string;
  productName: string;
  quantity: number;
  total: number;
}

async function sendTelegramOrderNotification(orderId: string, order: TelegramNotificationInput) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("stripe-webhook: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured -- skipping Telegram notification for order", orderId);
    return;
  }

  // parse_mode "HTML" (not "MarkdownV2") specifically so escapeHtml() --
  // already used everywhere else in this file -- is the only escaping this
  // needs. MarkdownV2 requires escaping a much longer list of characters
  // (., -, !, (, ), etc.) that a real product name/reference could easily
  // contain; getting that escaping wrong silently breaks the API call
  // (Telegram rejects malformed Markdown entities), whereas HTML mode only
  // ever cares about &/</>, exactly what escapeHtml() already handles.
  const text = [
    "🛍️ <b>Nouvelle commande payée</b>",
    "",
    `Référence : <b>${escapeHtml(order.referenceNumber || "-")}</b>`,
    `Produit : ${escapeHtml(order.productName)} × ${order.quantity}`,
    `Total : ${formatMoney(order.total)}`,
    "",
    // ADMIN_URL is a fixed constant (never user input), so no escapeHtml()
    // needed on it -- same reasoning as every other hardcoded URL already
    // embedded raw elsewhere in this file's own <a href="..."> attributes.
    `<a href="${ADMIN_URL}">Voir dans l'administration →</a>`,
  ].join("\n");

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Telegram API responded ${res.status}: ${errBody}`);
    }
  } catch (err) {
    console.error("stripe-webhook: Telegram order notification failed for order", orderId, ":", err instanceof Error ? err.message : err);
  }
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
): Promise<{ subtotal: number; discount: number; unitPrice: number }> {
  const { data: product, error } = await supabaseAdmin.from("products").select("price").limit(1).maybeSingle();
  if (error || !product) {
    console.error("stripe-webhook: product price lookup failed while building confirmation email price breakdown:", error?.message);
    return { subtotal: total, discount: 0, unitPrice: Math.round((total / Math.max(1, quantity)) * 100) / 100 };
  }
  const unitPrice = Number(product.price);
  const rawSubtotal = Math.round(unitPrice * quantity * 100) / 100;
  if (promoCode && rawSubtotal > total) {
    return { subtotal: rawSubtotal, discount: Math.round((rawSubtotal - total) * 100) / 100, unitPrice };
  }
  return { subtotal: total, discount: 0, unitPrice };
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
