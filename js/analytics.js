/* MONARK — Google Analytics 4 (gtag.js), gated entirely behind
   js/cookie-consent.js's own consent decision. Loaded on every page (see
   each HTML file's own <script> list) but does NOTHING at all -- no script
   injected, no dataLayer, no gtag call, no cookie set -- until consent is
   confirmed. Exposes window.MonarkAnalytics for the page-specific event
   hooks (product-page.js's view_item, js/cart.js's add_to_cart,
   checkout-page.js's begin_checkout/purchase, product-page.js's own
   Payment Request Button equivalents).

   GA4_MEASUREMENT_ID is this project's real Measurement ID (Google
   Analytics -> Admin -> Data Streams -> this site's web stream). loadGA4()
   below still keeps its own placeholder guard (logs one console.error, does
   nothing else) in case this ever gets reset/blanked out -- same "fails
   safe, doesn't ship silently broken" reasoning as js/supabase-client.js's
   own SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY placeholders. */
(function (global) {
  const GA4_MEASUREMENT_ID = 'G-7DNRLV4W7M';
  const CONSENT_STORAGE_KEY = 'monark_cookie_consent'; // matches js/cookie-consent.js's own STORAGE_KEY exactly
  const CURRENCY = 'EUR'; // matches create-checkout-session's own Stripe currency

  let gaLoaded = false;

  // Injects gtag.js itself (external script, same "no inline <script>"
  // requirement as everything else on this site post-CSP-hardening -- see
  // _headers' own script-src, which has no 'unsafe-inline') and initializes
  // the standard dataLayer/gtag plumbing. Idempotent -- safe to call more
  // than once (e.g. both the direct localStorage check below AND a
  // same-session 'monark:cookieconsent' event could theoretically both fire
  // this) since gaLoaded guards against injecting the script twice.
  function loadGA4() {
    if (gaLoaded) return;
    if (!GA4_MEASUREMENT_ID || GA4_MEASUREMENT_ID === 'G-XXXXXXXXXX') {
      console.error('MonarkAnalytics: GA4_MEASUREMENT_ID is still a placeholder -- see js/analytics.js\'s own top comment. GA4 will not load.');
      return;
    }
    gaLoaded = true;

    global.dataLayer = global.dataLayer || [];
    // Standard gtag.js bootstrap -- window.gtag deliberately not shadowing
    // any existing global here (this project has no other use of that name).
    global.gtag = function () { global.dataLayer.push(arguments); };
    global.gtag('js', new Date());
    // send_page_view defaults to true already -- listed explicitly so it's
    // obvious at a glance this fires a page_view for whatever page this
    // actually loaded on (immediately for a returning consented visitor, or
    // at the moment consent is freshly given for a first-time one -- see
    // this file's own init logic below for why that's the correct, expected
    // behavior rather than a bug).
    global.gtag('config', GA4_MEASUREMENT_ID, { send_page_view: true });

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA4_MEASUREMENT_ID);
    document.head.appendChild(script);
  }

  // ---------------- Consent gating ----------------
  // Two independent triggers, deliberately not just one, so this never
  // depends on script tag ORDER between this file and js/cookie-consent.js
  // (both are loaded via plain <script src> on every page, in whatever
  // order each page's own list happens to have them in):
  //
  // 1. Direct localStorage check, right now -- covers a RETURNING visitor
  //    who already consented in a previous session (this file's own
  //    "already consented in a previous session" requirement): GA4 loads on
  //    this page load with no re-asking, no event needed at all.
  // 2. 'monark:cookieconsent' listener -- covers a FIRST-time visitor who
  //    clicks Accept on the banner during THIS pageview, well after every
  //    script's own top-level code (including this listener registration)
  //    has already run, so there's no ordering race here either. Dispatched
  //    by js/cookie-consent.js itself on both a fresh choice AND (for
  //    symmetry/robustness, though unused by this file, which prefers the
  //    direct check above) its own early-return "already decided" path.
  if (global.localStorage && global.localStorage.getItem(CONSENT_STORAGE_KEY) === 'accepted') {
    loadGA4();
  }
  document.addEventListener('monark:cookieconsent', (e) => {
    if (e.detail && e.detail.choice === 'accepted') loadGA4();
    // 'rejected' needs no handling -- gaLoaded simply never becomes true,
    // so every trackX() below stays a no-op for the rest of this pageview.
  });

  // ---------------- E-commerce event helpers ----------------
  // Every one of these is a silent no-op until loadGA4() has actually run --
  // never queued for later replay on a subsequent consent grant (a
  // view_item/add_to_cart that happened before consent was given is, by
  // design, simply never reported -- reusing today's rejected-or-undecided
  // interaction retroactively once consent finally arrives would be
  // tracking activity that happened under "no consent", not activity that
  // happens to be reported late).

  function trackViewItem(product) {
    if (!gaLoaded || !product) return;
    global.gtag('event', 'view_item', {
      currency: CURRENCY,
      value: product.price,
      items: [{ item_id: product.id, item_name: product.name, price: product.price, quantity: 1 }]
    });
  }

  function trackAddToCart(product, quantity) {
    if (!gaLoaded || !product || !quantity) return;
    global.gtag('event', 'add_to_cart', {
      currency: CURRENCY,
      value: product.price * quantity,
      items: [{ item_id: product.id, item_name: product.name, price: product.price, quantity }]
    });
  }

  function trackBeginCheckout(product, quantity, value) {
    if (!gaLoaded || !product || !quantity) return;
    global.gtag('event', 'begin_checkout', {
      currency: CURRENCY,
      value,
      items: [{ item_id: product.id, item_name: product.name, price: product.price, quantity }]
    });
  }

  // purchase needs its own "at most once per PaymentIntent" guard, separate
  // from (and in addition to) gaLoaded above -- see this project's two call
  // sites (js/checkout-page.js's completeOrder(), product-page.js's Payment
  // Request Button handler) for exactly why: checkout.html's own
  // ?expressSuccess=1 confirmation URL is bookmarkable/refreshable, and
  // would otherwise re-report the same completed sale as a brand new
  // transaction on every reload. Deliberately fires from the BROWSER, right
  // after Stripe's own confirmPayment()/confirmCardPayment() response
  // reports paymentIntent.status === 'succeeded' at each call site (Stripe's
  // own API already authoritatively confirmed the charge at that point --
  // this is not "assumed" success), rather than waiting on
  // supabase/functions/stripe-webhook's own later, independent
  // confirmation: the webhook exists for durable order-record bookkeeping
  // (see its own header comment), and per that same comment is NOT even
  // required for checkout to work today ("Until all five steps are done...
  // checkout keeps working exactly as it does today") -- making GA4
  // purchase tracking depend on it would mean zero purchase events on this
  // project until/unless that separate manual setup is complete, which is a
  // worse failure mode than the dedup-guarded client-side signal used here.
  const PURCHASE_TRACKED_PREFIX = 'monark_ga_purchase_';
  function trackPurchase(paymentIntentId, product, quantity, value) {
    if (!gaLoaded || !paymentIntentId || !product || !quantity) return;
    const dedupeKey = PURCHASE_TRACKED_PREFIX + paymentIntentId;
    try {
      if (global.localStorage.getItem(dedupeKey)) return; // already reported this exact PaymentIntent
      global.localStorage.setItem(dedupeKey, '1');
    } catch (e) {
      // localStorage unavailable (private browsing quota edge cases, etc.) --
      // falls through and reports anyway rather than silently dropping a
      // real sale over a dedup mechanism that itself failed; the rare
      // resulting double-count is a smaller problem than under-reporting
      // revenue entirely.
    }
    global.gtag('event', 'purchase', {
      transaction_id: paymentIntentId,
      currency: CURRENCY,
      value,
      items: [{ item_id: product.id, item_name: product.name, price: product.price, quantity }]
    });
  }

  global.MonarkAnalytics = { trackViewItem, trackAddToCart, trackBeginCheckout, trackPurchase };
})(window);
