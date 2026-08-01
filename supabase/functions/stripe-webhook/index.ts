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
//
// Until all five steps are done, Stripe has nowhere to send these events, so
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
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("orders")
    .select("id, status, reference_number")
    .eq("payment_intent_id", paymentIntent.id)
    .maybeSingle();
  if (lookupError) throw lookupError;

  if (existing) {
    if (existing.status === "paid") return; // already reconciled -- Stripe redelivering the same event, a safe no-op
    const referenceNumber = existing.reference_number || (await generateReferenceNumber(supabaseAdmin));
    const { error: updateError } = await supabaseAdmin
      .from("orders")
      .update({ status: "paid", reference_number: referenceNumber })
      .eq("id", existing.id);
    if (updateError) throw updateError;
    return;
  }

  // No row yet -- either this webhook genuinely arrived before
  // recordOrder()'s own client-side insert, or that insert never happened
  // at all. Build a complete row straight from the PaymentIntent: amount_received
  // is Stripe's own confirmed charge (the source of truth for `total` here,
  // not whatever the client last displayed), metadata carries
  // quantity/identity (see create-checkout-session's own comment on why
  // it's set there).
  const metadata = paymentIntent.metadata || {};
  const quantity = Math.max(1, Math.floor(Number(metadata.quantity)) || 1);
  const referenceNumber = await generateReferenceNumber(supabaseAdmin);
  const row: Record<string, unknown> = {
    payment_intent_id: paymentIntent.id,
    product_name: metadata.product_name || DEFAULT_PRODUCT_NAME,
    quantity,
    total: paymentIntent.amount_received / 100,
    status: "paid",
    reference_number: referenceNumber,
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

  const { error: insertError } = await supabaseAdmin.from("orders").insert(row);
  if (!insertError) return;

  if (insertError.code === "23505") {
    // Lost a race against another concurrent insert for this exact
    // PaymentIntent (recordOrder()'s own client-side call, or a second
    // near-simultaneous webhook delivery) -- that row now exists, so finish
    // the job by updating IT to 'paid' instead of erroring out.
    const { data: raceWinner, error: refetchError } = await supabaseAdmin
      .from("orders")
      .select("id, status, reference_number")
      .eq("payment_intent_id", paymentIntent.id)
      .maybeSingle();
    if (refetchError) throw refetchError;
    if (raceWinner && raceWinner.status !== "paid") {
      const finalReference = raceWinner.reference_number || referenceNumber;
      const { error: updateError } = await supabaseAdmin
        .from("orders")
        .update({ status: "paid", reference_number: finalReference })
        .eq("id", raceWinner.id);
      if (updateError) throw updateError;
    }
    return;
  }
  throw insertError;
}

async function generateReferenceNumber(supabaseAdmin: ReturnType<typeof createClient>): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc("generate_order_reference");
  if (error) throw error;
  return data as string;
}
