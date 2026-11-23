// Catalog of every transactional email the site sends, each built with
// realistic FAKE data (never real customer data) by the same pure builders
// the production edge functions use. Used by scripts/send-test-emails.mjs.
//
// Takes the builder modules as an argument (instead of importing them here)
// so the same catalog can also be run against other copies of the builders,
// e.g. to check that a refactor kept the output byte-identical.

// Real product name, fake everything else. Prices are passed in by the
// caller (scripts/send-test-emails.mjs reads them from js/cart.js PRODUCT).
const PRODUCT_NAME = "MONARK Eau de Parfum | 100ml";
const DEFAULT_PRICES = { price: 149, originalPrice: 189 };
const FAKE_PROMO = { code: "MONARK10", percent: 10 };
const FAKE_PHONE = "+33 612345678";
const FAKE_PAYMENT_METHOD = "Visa •••• 4242";
const FAKE_ORDER_REF = "TEST7K2M";
const FAKE_CUSTOMER = {
  email: "camille.martin@example.com",
  name: "Camille Martin",
  line1: "12 rue des Archives",
  line2: "Bâtiment B, 3e étage",
  city: "Paris",
  postalCode: "75003",
  country: "FR",
};
const FAKE_TRACKING_NUMBER = "6A12345678901";
const FAKE_DISCOUNT_CODE = "BACK5-TEST42";
const FAKE_LINK = "https://effluve-paris.fr/account.html";

/**
 * @param {"fr"|"en"} lang
 * @param {{ auth: any, order: any, shipped: any, delivered: any, cart: any }} m
 *   the email.ts modules of send-auth-email, stripe-webhook,
 *   mark-order-shipped, ship24-webhook and send-abandoned-cart-reminders.
 * @param {{ price: number, originalPrice: number }} [prices] real site prices
 * @returns {{ name: string, build: () => { subject: string, html: string, text: string } }[]}
 */
export function emailCatalog(lang, m, prices = DEFAULT_PRICES) {
  const now = new Date().toISOString();
  const PRICE = prices.price;
  // Same rounding as create-checkout-session: cents, then the code's percentage.
  const promoTotal = Math.round(Math.round(PRICE * 100) * (1 - FAKE_PROMO.percent / 100)) / 100;
  const cartPricing = (quantity) => ({ quantity, unitPrice: prices.price, originalPrice: prices.originalPrice });
  const shippedBase = {
    language: lang,
    firstName: "Camille",
    referenceNumber: FAKE_ORDER_REF,
    productName: PRODUCT_NAME,
    trackingNumber: FAKE_TRACKING_NUMBER,
    carrier: "colissimo",
    carrierOtherName: "",
    postalCode: FAKE_CUSTOMER.postalCode,
  };
  return [
    // send-auth-email
    { name: "signup-code", build: () => m.auth.buildAuthEmail("signup", lang, undefined, "123456") },
    { name: "password-recovery", build: () => m.auth.buildAuthEmail("recovery", lang, FAKE_LINK, undefined) },
    { name: "email-change", build: () => m.auth.buildAuthEmail("email_change", lang, FAKE_LINK, undefined) },
    {
      name: "auth-fallback",
      // Any unrecognized action type renders the generic fallback. The
      // builder logs that on purpose in production; muted here.
      build: () => {
        const original = console.error;
        console.error = () => {};
        try {
          return m.auth.buildAuthEmail("preview_unknown_action", lang, FAKE_LINK, undefined);
        } finally {
          console.error = original;
        }
      },
    },
    // stripe-webhook
    {
      name: "order-confirmation",
      build: () =>
        m.order.buildConfirmationEmail({
          email: FAKE_CUSTOMER.email,
          language: lang,
          referenceNumber: FAKE_ORDER_REF,
          productName: PRODUCT_NAME,
          quantity: 1,
          total: PRICE,
          createdAt: now,
          subtotal: PRICE,
          discount: 0,
          promoCode: "",
          shippingName: FAKE_CUSTOMER.name,
          shippingAddressLine1: FAKE_CUSTOMER.line1,
          shippingAddressLine2: FAKE_CUSTOMER.line2,
          shippingCity: FAKE_CUSTOMER.city,
          shippingPostalCode: FAKE_CUSTOMER.postalCode,
          shippingCountry: FAKE_CUSTOMER.country,
        }),
    },
    {
      // Internal owner notification: always French in production.
      name: "order-internal-notification",
      build: () =>
        // With a fake promo code applied, so the discount row shows.
        m.order.buildInternalOrderNotificationEmail({
          referenceNumber: FAKE_ORDER_REF,
          createdAt: now,
          productName: PRODUCT_NAME,
          quantity: 1,
          unitPrice: PRICE,
          subtotal: PRICE,
          discount: Math.round((PRICE - promoTotal) * 100) / 100,
          promoCode: FAKE_PROMO.code,
          total: promoTotal,
          customerEmail: FAKE_CUSTOMER.email,
          customerPhone: FAKE_PHONE,
          isGuest: true,
          customerLanguage: lang,
          shippingName: FAKE_CUSTOMER.name,
          shippingAddressLine1: FAKE_CUSTOMER.line1,
          shippingAddressLine2: FAKE_CUSTOMER.line2,
          shippingCity: FAKE_CUSTOMER.city,
          shippingPostalCode: FAKE_CUSTOMER.postalCode,
          shippingCountry: FAKE_CUSTOMER.country,
          paymentMethod: FAKE_PAYMENT_METHOD,
        }),
    },
    // mark-order-shipped
    { name: "shipped", build: () => m.shipped.buildShippingEmail({ ...shippedBase, isCorrection: false }) },
    { name: "shipped-correction", build: () => m.shipped.buildShippingEmail({ ...shippedBase, isCorrection: true }) },
    // ship24-webhook
    {
      name: "delivered",
      build: () =>
        m.delivered.buildDeliveredEmail({
          language: lang,
          firstName: "Camille",
          referenceNumber: FAKE_ORDER_REF,
          productName: PRODUCT_NAME,
          deliveredAtIso: now,
        }),
    },
    // send-abandoned-cart-reminders
    { name: "cart-reminder-1", build: () => m.cart.buildStage1Email(lang, cartPricing(1)) },
    { name: "cart-reminder-1-qty2", build: () => m.cart.buildStage1Email(lang, cartPricing(2)) },
    { name: "cart-reminder-2", build: () => m.cart.buildStage2Email(lang, FAKE_DISCOUNT_CODE, cartPricing(1)) },
    { name: "cart-reminder-2-qty2", build: () => m.cart.buildStage2Email(lang, FAKE_DISCOUNT_CODE, cartPricing(2)) },
  ];
}
