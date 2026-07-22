// Creates (or, on repeat calls for the same checkout, updates the amount on)
// a Stripe PaymentIntent for the MONARK checkout flow. Called from
// checkout.html via supabase.functions.invoke('create-checkout-session', ...)
// once the Facturation/Billing step is reached, and again whenever the cart
// changes (quantity via the header's mini-cart, or a promo code applied)
// while that step is already open -- see checkout.html's initStripePayment()
// for the two call sites.
//
// auth: "publishable" -- gated to requests carrying this project's anon/
// publishable key (which supabase-js always sends as the `apikey` header,
// logged in or guest), but the resulting ctx.supabase client is anonymous:
// RLS-scoped, not privileged. That's deliberate -- this function only ever
// needs the public.products row anyone can already read, never anything
// user-specific, so there's no reason to touch the service role here.
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import Stripe from "stripe";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");

// Mirrors js/cart.js's PROMO_CODES map -- there's no promo-codes table yet,
// so this is the one other place (besides cart.js) that has to know the
// valid codes/rates, kept deliberately tiny and hand-synced with that file
// for now. A real promo-codes table would let both this function and
// cart.js read from one source instead of two independently-maintained
// copies -- a follow-up, not attempted here.
const PROMO_CODES: Record<string, number> = {
  MONARK10: 0.10,
};

interface RequestBody {
  quantity?: unknown;
  promoCode?: unknown;
  paymentIntentId?: unknown;
}

export default {
  fetch: withSupabase({ auth: "publishable" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    if (!STRIPE_SECRET_KEY) {
      console.error("create-checkout-session: STRIPE_SECRET_KEY is not configured.");
      return Response.json({ error: "Payments are not configured." }, { status: 500 });
    }

    let body: RequestBody;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }

    // Bounded to a sane range -- this only guards against garbage input, not
    // real stock (stock itself isn't decremented anywhere yet, see
    // product.html's own comment on that follow-up).
    const quantity = Math.min(50, Math.max(1, Math.floor(Number(body.quantity)) || 1));
    const rawPromoCode = typeof body.promoCode === "string" ? body.promoCode.trim().toUpperCase() : "";
    const paymentIntentId = typeof body.paymentIntentId === "string" && body.paymentIntentId ? body.paymentIntentId : null;

    // Server-side price lookup -- the amount charged is never taken from the
    // client. products is publicly readable (see its RLS policy), and
    // there's only ever the one current MONARK edition's row to read.
    const { data: product, error: productError } = await ctx.supabase
      .from("products")
      .select("price")
      .limit(1)
      .maybeSingle();

    if (productError || !product) {
      console.error("create-checkout-session: product lookup failed:", productError?.message);
      return Response.json({ error: "Could not determine order amount." }, { status: 500 });
    }

    // Stripe wants the smallest currency unit (cents for EUR).
    let amount = Math.round(product.price * quantity * 100);
    const discountRate = PROMO_CODES[rawPromoCode];
    const appliedPromoCode = discountRate ? rawPromoCode : "";
    if (discountRate) amount = Math.round(amount * (1 - discountRate));

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    try {
      let paymentIntent: Stripe.PaymentIntent;
      if (paymentIntentId) {
        // Re-invoked because the cart changed while Payment was already
        // open (quantity edit, promo code applied/removed) -- update the
        // SAME PaymentIntent's amount rather than creating a new one, so
        // the client_secret already handed to Stripe Elements stays valid
        // and checkout.html only has to call elements.fetchUpdates().
        paymentIntent = await stripe.paymentIntents.update(paymentIntentId, {
          amount,
          metadata: { quantity: String(quantity), promo_code: appliedPromoCode },
        });
      } else {
        paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: "eur",
          // Card-only this round -- see the task's own Apple Pay follow-up
          // note; Payment Element can support more methods later without
          // this function changing.
          payment_method_types: ["card"],
          metadata: { quantity: String(quantity), promo_code: appliedPromoCode },
        });
      }

      return Response.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount,
      });
    } catch (err) {
      // A PaymentIntent already past 'requires_payment_method' (e.g. mid
      // confirmation, or a stale id from a previous page load) can't have
      // its amount updated -- Stripe raises for that case too, surfaced
      // here as a generic init error so the client falls back to asking
      // for a page refresh rather than silently charging a stale amount.
      console.error("create-checkout-session: Stripe error:", err instanceof Error ? err.message : err);
      return Response.json({ error: "Payment initialization failed. Please try again." }, { status: 502 });
    }
  }),
};
