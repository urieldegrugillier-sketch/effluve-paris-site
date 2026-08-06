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

interface RequestBody {
  quantity?: unknown;
  promoCode?: unknown;
  paymentIntentId?: unknown;
  // Who this checkout belongs to -- client-supplied, same trust level
  // js/account.js's own recordOrder() already relies on for guest_email (a
  // guest has no server-verified identity to begin with), extended here to
  // userId too rather than trying to derive it from the caller's own auth
  // context. Needed so supabase/functions/stripe-webhook -- which runs with
  // NO knowledge of this browser session at all, hours or days later,
  // triggered by Stripe rather than the client -- can still attribute the
  // order to the right account/guest email from the PaymentIntent's own
  // metadata alone, even if the client-side recordOrder() call never
  // happens (tab closed right after payment, network drop, etc.).
  userId?: unknown;
  guestEmail?: unknown;
  // Order-confirmation email target/language (see supabase/functions/
  // stripe-webhook, which reads these back off the PaymentIntent's own
  // metadata the same way it already reads user_id/guest_email below).
  // customerEmail is sent for BOTH guest and logged-in sessions (unlike
  // guestEmail, which is guest-only) -- see checkout.html's own call site.
  customerEmail?: unknown;
  language?: unknown;
  // Shipping step's own fields, sent purely so the confirmation email can
  // print a shipping-address recap (see checkout.html's own call site for
  // why these are read straight off the form rather than off Stripe's
  // payment_method.billing_details later). Same trust level as guestEmail/
  // customerEmail above -- never used for anything except display in an
  // email the customer themselves receives, so a tampered value only ever
  // misleads the sender, not the recipient.
  shippingName?: unknown;
  shippingAddressLine1?: unknown;
  shippingAddressLine2?: unknown;
  shippingCity?: unknown;
  shippingPostalCode?: unknown;
  shippingCountry?: unknown;
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
    const userId = typeof body.userId === "string" && body.userId ? body.userId : "";
    const guestEmail = typeof body.guestEmail === "string" && body.guestEmail ? body.guestEmail.trim() : "";
    const customerEmail = typeof body.customerEmail === "string" && body.customerEmail ? body.customerEmail.trim() : "";
    const language = body.language === "fr" || body.language === "en" ? body.language : "";
    const asTrimmedString = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
    const shippingName = asTrimmedString(body.shippingName);
    const shippingAddressLine1 = asTrimmedString(body.shippingAddressLine1);
    const shippingAddressLine2 = asTrimmedString(body.shippingAddressLine2);
    const shippingCity = asTrimmedString(body.shippingCity);
    const shippingPostalCode = asTrimmedString(body.shippingPostalCode);
    const shippingCountry = asTrimmedString(body.shippingCountry);

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

    // Server-side promo lookup -- the discount actually charged is never
    // taken from the client either. checkout.html/js/cart.js's own
    // applyPromoCode() calls the separate validate-promo-code function
    // purely for the UI preview (the success message, the displayed total);
    // that response is never trusted here. Same active/expires_at/max_uses
    // checks as validate-promo-code -- duplicated rather than shared,
    // matching this project's existing pattern of self-contained
    // single-file functions (no _shared/ import between check-email-exists/
    // create-checkout-session either). Any lookup failure (including "code
    // not found") is treated as no discount rather than an error -- an
    // invalid/stale promo code shouldn't block placing an order at full price.
    let discountRate = 0;
    if (rawPromoCode) {
      const { data: promo } = await ctx.supabase
        .from("promo_codes")
        .select("discount_percent, active, max_uses, times_used, expires_at")
        .eq("code", rawPromoCode)
        .maybeSingle();
      const isValid =
        !!promo &&
        promo.active &&
        (!promo.expires_at || new Date(promo.expires_at) > new Date()) &&
        (promo.max_uses === null || promo.times_used < promo.max_uses);
      if (isValid) discountRate = promo!.discount_percent / 100;
    }

    // Stripe wants the smallest currency unit (cents for EUR).
    let amount = Math.round(product.price * quantity * 100);
    const appliedPromoCode = discountRate ? rawPromoCode : "";
    if (discountRate) amount = Math.round(amount * (1 - discountRate));

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    // Stripe metadata values are always strings, and omitted/empty ones just
    // aren't included -- Stripe.paymentIntents.update() merges into existing
    // metadata rather than replacing the whole object, so a re-invocation
    // missing userId/guestEmail (this function's own callers always send
    // whichever one applies, but this stays robust either way) doesn't erase
    // identity metadata a previous call already set.
    // product_name is a fixed constant, not read from anywhere client-
    // supplied -- see js/cart.js's own single hardcoded PRODUCT.name, this
    // project's one current MONARK edition -- so supabase/functions/
    // stripe-webhook can build a real order row even when it has to create
    // one from scratch (the client-side recordOrder() insert never landed).
    const metadata: Record<string, string> = { quantity: String(quantity), promo_code: appliedPromoCode };
    if (userId) metadata.user_id = userId;
    if (guestEmail) metadata.guest_email = guestEmail;
    if (customerEmail) metadata.customer_email = customerEmail;
    if (language) metadata.language = language;
    if (shippingName) metadata.shipping_name = shippingName;
    if (shippingAddressLine1) metadata.shipping_address_line1 = shippingAddressLine1;
    if (shippingAddressLine2) metadata.shipping_address_line2 = shippingAddressLine2;
    if (shippingCity) metadata.shipping_city = shippingCity;
    if (shippingPostalCode) metadata.shipping_postal_code = shippingPostalCode;
    if (shippingCountry) metadata.shipping_country = shippingCountry;

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
          metadata,
        });
      } else {
        paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: "eur",
          // Card-only this round -- see the task's own Apple Pay follow-up
          // note; Payment Element can support more methods later without
          // this function changing.
          payment_method_types: ["card"],
          metadata,
        });
      }

      // Abandoned-cart tracking (see public.abandoned_checkouts' own
      // migration for the full picture) -- links this attempt's
      // payment_intent_id onto whatever tracking row the Account step's own
      // hook already created for this email (js/checkout-page.js's
      // trackAbandonedCheckout()), or creates one if that hook somehow never
      // ran. Never blocks or fails the actual checkout response below --
      // same "ancillary bookkeeping must never break the real flow"
      // reasoning as every other best-effort side effect in this codebase
      // (e.g. stripe-webhook's own incrementPromoCodeUsage/
      // sendConfirmationEmail). Uses ctx.supabase (the same RLS-scoped,
      // non-privileged client already used for the product/promo lookups
      // above), never the service role -- track_abandoned_checkout() is
      // exactly the SECURITY DEFINER function that makes that safe.
      const trackingEmail = customerEmail || guestEmail;
      if (trackingEmail) {
        const { error: trackError } = await ctx.supabase.rpc("track_abandoned_checkout", {
          p_email: trackingEmail,
          p_language: language || "fr",
          p_user_id: userId || null,
          p_payment_intent_id: paymentIntent.id,
        });
        if (trackError) {
          console.error("create-checkout-session: track_abandoned_checkout failed:", trackError.message);
        }
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
