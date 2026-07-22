/* MONARK — Stripe.js client initialization.
   checkout.html only -- Payment is the one page that needs it, unlike
   js/supabase-client.js which every page loads for account state. Requires
   the Stripe.js CDN script (https://js.stripe.com/v3/, exposes the global
   `Stripe()` constructor) to be loaded first. Exposes the initialized
   instance as window.MonarkStripe.

   PLACEHOLDER VALUE BELOW -- replace STRIPE_PUBLISHABLE_KEY with this
   project's real TEST-mode publishable key (Stripe dashboard -> Developers
   -> API keys -> Publishable key, starts with pk_test_ while in test mode)
   before checkout.html's Payment step can do anything. The publishable key
   is safe to ship client-side -- it can only create PaymentIntents/confirm
   payments, never move money or read account data, that's what
   STRIPE_SECRET_KEY (server-side only, in the Edge Function) is for. Swap
   for a pk_live_ key only once real payment processing is actually wanted --
   this integration is TEST MODE only for now (see checkout.html's own
   "Test mode" note next to the payment form). */
(function (global) {
  const STRIPE_PUBLISHABLE_KEY = 'pk_test_51Tw4wCFTruLrROK3uSzND7jTO8IhndN0mdbMV1Vly349aPGC6WlCOj7g84mqG3X2UTpCmawRrCD6DJey3A8mXW9j00aGTUpAPZ'; // PLACEHOLDER

  if (!global.Stripe) {
    console.error('MonarkStripe: Stripe.js not loaded -- check the https://js.stripe.com/v3/ <script> tag is present before this file.');
    return;
  }

  global.MonarkStripe = global.Stripe(STRIPE_PUBLISHABLE_KEY);
})(window);
