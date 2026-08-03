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
// commandes@ on effluve-paris.fr -- the domain verified in Resend (SPF/DKIM);
// sending "from" any other domain would get the message rejected by Resend
// outright, not just marked spam.
const FROM_ADDRESS = "Effluve Paris <commandes@effluve-paris.fr>";

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
    .select("id, status, reference_number, product_name, quantity, total, guest_email, user_id")
    .eq("payment_intent_id", paymentIntent.id)
    .maybeSingle();
  if (lookupError) throw lookupError;

  if (existing) {
    if (existing.status === "paid") return; // already reconciled -- Stripe redelivering the same event, a safe no-op (also why the confirmation email never double-sends on retries)
    const referenceNumber = existing.reference_number || (await generateReferenceNumber(supabaseAdmin));
    const { error: updateError } = await supabaseAdmin
      .from("orders")
      .update({ status: "paid", reference_number: referenceNumber })
      .eq("id", existing.id);
    if (updateError) throw updateError;
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
  const referenceNumber = await generateReferenceNumber(supabaseAdmin);
  const productName = (metadata.product_name as string) || DEFAULT_PRODUCT_NAME;
  const total = paymentIntent.amount_received / 100;
  const row: Record<string, unknown> = {
    payment_intent_id: paymentIntent.id,
    product_name: productName,
    quantity,
    total,
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

  const { data: inserted, error: insertError } = await supabaseAdmin.from("orders").insert(row).select("id").single();
  if (!insertError) {
    await sendOrderConfirmation(supabaseAdmin, metadata, inserted.id, {
      referenceNumber,
      productName,
      quantity,
      total,
      guestEmail: (row.guest_email as string) || null,
      userId: (row.user_id as string) || null,
    });
    return;
  }

  if (insertError.code === "23505") {
    // Lost a race against another concurrent insert for this exact
    // PaymentIntent (recordOrder()'s own client-side call, or a second
    // near-simultaneous webhook delivery) -- that row now exists, so finish
    // the job by updating IT to 'paid' instead of erroring out.
    const { data: raceWinner, error: refetchError } = await supabaseAdmin
      .from("orders")
      .select("id, status, reference_number, product_name, quantity, total, guest_email, user_id")
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
      await sendOrderConfirmation(supabaseAdmin, metadata, raceWinner.id, {
        referenceNumber: finalReference,
        productName: raceWinner.product_name,
        quantity: raceWinner.quantity,
        total: raceWinner.total,
        guestEmail: raceWinner.guest_email,
        userId: raceWinner.user_id,
      });
    }
    return;
  }
  throw insertError;
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
  await sendConfirmationEmail(supabaseAdmin, orderId, {
    email,
    language,
    referenceNumber: order.referenceNumber,
    productName: order.productName,
    quantity: order.quantity,
    total: order.total,
  });
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

  const { subject, html } = buildConfirmationEmail(details);

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

function buildConfirmationEmail(details: ConfirmationEmailDetails): { subject: string; html: string } {
  const isFr = details.language === "fr";
  const totalFormatted = formatMoney(details.total);
  const productName = escapeHtml(details.productName);

  const subject = isFr
    ? `Votre commande Effluve Paris — ${details.referenceNumber}`
    : `Your Effluve Paris order — ${details.referenceNumber}`;

  const heading = isFr ? "Merci pour votre commande" : "Thank you for your order";
  const introLine = isFr
    ? `Votre commande <strong>${details.referenceNumber}</strong> a bien été confirmée.`
    : `Your order <strong>${details.referenceNumber}</strong> has been confirmed.`;
  const thankYou = isFr
    ? "Nous vous remercions pour la confiance que vous accordez à Effluve Paris."
    : "We thank you for placing your trust in Effluve Paris.";
  const shipping = isFr
    ? "Votre commande sera expédiée sous peu, à l'adresse indiquée lors de votre commande (livraison en France et en Belgique)."
    : "Your order will be shipped shortly, to the address provided at checkout (shipping to France and Belgium).";
  const signOff = isFr ? "À bientôt," : "See you soon,";
  const footerNote = isFr
    ? "Une question sur votre commande ? Répondez simplement à cet e-mail."
    : "Any question about your order? Just reply to this email.";
  const labels = {
    reference: isFr ? "Référence" : "Reference",
    product: isFr ? "Produit" : "Product",
    quantity: isFr ? "Quantité" : "Quantity",
    total: isFr ? "Total réglé" : "Total paid",
  };

  const html = `<!doctype html>
<html lang="${details.language}">
  <body style="margin:0;padding:0;background:#0a0908;font-family:'Manrope',Arial,sans-serif;color:#ede7dd;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0908;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#141210;border:1px solid #2a2620;">
            <tr>
              <td style="padding:32px 32px 24px;text-align:center;border-bottom:1px solid #2a2620;">
                <div style="font-family:'IBM Plex Mono',Consolas,monospace;letter-spacing:0.2em;font-size:12px;color:#d8b27c;text-transform:uppercase;">Effluve Paris</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#ede7dd;">${heading}</h1>
                <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#ede7dd;">${introLine}</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-collapse:collapse;">
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#8f887c;">${labels.reference}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#ede7dd;text-align:right;">${details.referenceNumber}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#8f887c;">${labels.product}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#ede7dd;text-align:right;">${productName}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#8f887c;">${labels.quantity}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #2a2620;font-size:13px;color:#ede7dd;text-align:right;">${details.quantity}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 0;font-size:13px;color:#8f887c;">${labels.total}</td>
                    <td style="padding:10px 0;font-size:13px;color:#d8b27c;text-align:right;font-weight:600;">${totalFormatted}</td>
                  </tr>
                </table>
                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">${thankYou}</p>
                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">${shipping}</p>
                <p style="margin:24px 0 0;font-size:14px;line-height:1.6;color:#ede7dd;">${signOff}<br>Effluve Paris</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;border-top:1px solid #2a2620;text-align:center;">
                <p style="margin:0;font-size:12px;color:#8f887c;">${footerNote}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html };
}

async function generateReferenceNumber(supabaseAdmin: ReturnType<typeof createClient>): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc("generate_order_reference");
  if (error) throw error;
  return data as string;
}
