// Playwright test helper -- stands in for the real https://js.stripe.com/v3/
// CDN script (which js/stripe-client.js turns into window.MonarkStripe) so
// specs that need to reach checkout.html's Payment step can do so fully
// offline, the same way tests/supabase-mock.js stands in for the real
// Supabase SDK. Installed via page.addInitScript(), which runs before any of
// the page's own <script> tags, so window.Stripe already exists by the time
// js/stripe-client.js's own `global.Stripe(STRIPE_PUBLISHABLE_KEY)` call runs.
//
// The real CDN script (STRIPE_CDN_URL below) must be blocked by the test
// (page.route(STRIPE_CDN_URL, (route) => route.abort())) so it can never
// overwrite this mock's window.Stripe with the real constructor.
//
// Deliberately minimal -- only the surface js/checkout-page.js actually
// calls: elements()/create()/mount()/fetchUpdates() for the card Payment
// Element, and paymentRequest()/canMakePayment() for the Apple Pay/Google
// Pay/Link button (resolving null, i.e. "no eligible wallet," keeps that
// whole optional path a no-op so specs never need to deal with it).
// confirmPayment()/confirmCardPayment() are stubbed too, for any spec that
// does click Place Order all the way through -- not exercised by the
// accordion/terms-checkbox specs this was first written for, which never
// click Place Order while it's actually enabled.
const STRIPE_CDN_URL = 'https://js.stripe.com/v3/';

function installStripeMock() {
  function fakeElement() {
    return { mount() {}, unmount() {}, on() {}, update() {} };
  }
  window.Stripe = function () {
    return {
      elements() {
        return {
          create() { return fakeElement(); },
          getElement() { return fakeElement(); },
          fetchUpdates: async () => {}
        };
      },
      paymentRequest() {
        return {
          canMakePayment: async () => null,
          update() {},
          on() {},
          show() {}
        };
      },
      confirmPayment: async () => ({ paymentIntent: { status: 'succeeded' }, error: null }),
      confirmCardPayment: async () => ({ paymentIntent: { status: 'succeeded' }, error: null })
    };
  };
}

module.exports = { STRIPE_CDN_URL, installStripeMock };
