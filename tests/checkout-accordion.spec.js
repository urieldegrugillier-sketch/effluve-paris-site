// Checkout accordion/Place Order specs -- exercises js/checkout-page.js's
// own accordion state machine (STEP_ORDER/sectionState/completedFlags,
// invalidateForward(), updateSubmitBtnState()) against the real page, with
// the real Supabase JS SDK and Stripe.js both blocked and replaced by
// tests/supabase-mock.js / tests/stripe-mock.js's own fakes -- same pattern
// tests/signup-otp.spec.js already uses for the Supabase side, extended here
// so the flow can actually reach Shipping/Payment without a real backend.
//
// Covers:
//  - Place Order stays disabled until the Terms checkbox is ticked, and
//    re-disables if it's unticked again (point 1), plus the submit
//    handler's own safety-net check for a submit that bypasses the button.
//  - A completed step's header stays reopenable at any time, and the user
//    can jump straight back to Payment without re-clicking Next Step, as
//    long as nothing was actually changed in between (point 2).
//  - Editing a step's data after reopening it locks the later steps again
//    until that step is re-validated via Next Step (point 2).
//  - The collapsed-step summary renders as its own full-width second line,
//    with the right content per step, at both desktop and 390px (point 3).
const { test, expect } = require('@playwright/test');
const { SUPABASE_CDN_URL, installSupabaseMock } = require('./supabase-mock');
const { STRIPE_CDN_URL, installStripeMock } = require('./stripe-mock');

test.beforeEach(async ({ page }) => {
  await page.route(SUPABASE_CDN_URL, (route) => route.abort());
  await page.route(STRIPE_CDN_URL, (route) => route.abort());
  // Real Google Places Autocomplete key is configured in
  // js/places-autocomplete.js -- blocked here the same way the other two
  // CDN scripts are so the Address field never actually hits a live Google
  // endpoint (and never gets placesEnhanced, which keeps validateShippingForm()'s
  // "pick a suggestion" nudge from ever firing against this spec's
  // hand-typed address).
  await page.route('https://maps.googleapis.com/**', (route) => route.abort());
  await page.addInitScript(installSupabaseMock);
  await page.addInitScript(installStripeMock);
});

function uniqueEmail(tag) {
  return `${tag}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function gotoCheckout(page, lang) {
  await page.addInitScript((l) => { localStorage.setItem('monark_lang', l); }, lang);
  await page.goto('/checkout.html');
}

async function continueAsGuest(page, email) {
  await page.fill('#checkout-account-email-input', email);
  await page.click('#checkout-account-email-submit-btn');
  await page.click('#checkout-account-guest-btn');
  await expect(page.locator('#checkout-shipping-header')).toHaveAttribute('aria-expanded', 'true');
}

async function fillShipping(page, overrides = {}) {
  const data = {
    firstName: 'Jean',
    lastName: 'Dupont',
    address: '12 Rue de la Paix',
    city: 'Paris',
    postal: '75001',
    ...overrides
  };
  await page.fill('[name="firstName"]', data.firstName);
  await page.fill('[name="lastName"]', data.lastName);
  await page.fill('[name="address"]', data.address);
  await page.fill('[name="city"]', data.city);
  await page.fill('[name="postal"]', data.postal);
}

// Takes a fresh checkout.html load (lang defaults to 'en') all the way to
// the Payment step as a guest: adds the one product to the cart first
// (Payment needs a non-empty cart to ever mount anything, see
// applyCartEmptyVisuals() in js/checkout-page.js), resolves Account as
// guest, fills a valid Shipping form, and clicks Next Step.
async function reachPayment(page, email, lang = 'en') {
  await gotoCheckout(page, lang);
  await page.evaluate(() => window.MonarkCart.addToCart(1));
  await continueAsGuest(page, email);
  await fillShipping(page);
  await page.click('#checkout-shipping-next-btn');
  await expect(page.locator('#checkout-payment-header')).toHaveAttribute('aria-expanded', 'true');
}

test('Place Order stays disabled until Terms is ticked, and re-disables when unticked (EN)', async ({ page }) => {
  await reachPayment(page, uniqueEmail('terms'));
  const submitBtn = page.locator('#checkout-submit-btn');

  await expect(submitBtn).toBeDisabled();
  await expect(submitBtn).toHaveAttribute('aria-disabled', 'true');

  await page.check('#checkout-terms-checkbox');
  await expect(submitBtn).toBeEnabled();
  await expect(submitBtn).toHaveAttribute('aria-disabled', 'false');

  await page.uncheck('#checkout-terms-checkbox');
  await expect(submitBtn).toBeDisabled();
  await expect(submitBtn).toHaveAttribute('aria-disabled', 'true');
});

test('submitting the form directly while Terms is unticked still shows the existing error (safety net) (FR)', async ({ page }) => {
  await reachPayment(page, uniqueEmail('safetynet'), 'fr');
  // Bypasses the (disabled) button entirely -- requestSubmit() runs the
  // form's own submission steps directly, exercising the submit handler's
  // own `if (!termsCheckbox.checked)` guard the same way a programmatic or
  // Enter-key submit would.
  await page.evaluate(() => document.getElementById('checkout-form').requestSubmit());
  await expect(page.locator('#checkout-terms-error')).toBeVisible();
});

test('a completed step stays reopenable, and Payment is reachable directly without re-clicking Next Step (EN)', async ({ page }) => {
  await reachPayment(page, uniqueEmail('reopen'));

  // Reopen Shipping (already completed) without changing anything.
  await page.click('#checkout-shipping-header');
  await expect(page.locator('#checkout-shipping-header')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#checkout-payment-header')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#checkout-payment-header')).toBeEnabled();

  // Jump straight back to Payment by clicking ITS header -- no Next Step.
  await page.click('#checkout-payment-header');
  await expect(page.locator('#checkout-payment-header')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#checkout-shipping-header')).toHaveAttribute('aria-expanded', 'false');

  // Account (also completed) is reachable the same way, from here.
  await page.click('#checkout-account-header');
  await expect(page.locator('#checkout-account-header')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#checkout-payment-header')).toBeEnabled();
});

test('a completed step header is keyboard-activatable with Enter and Space (EN)', async ({ page }) => {
  await reachPayment(page, uniqueEmail('kbd'));

  await page.locator('#checkout-shipping-header').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#checkout-shipping-header')).toHaveAttribute('aria-expanded', 'true');

  await page.locator('#checkout-payment-header').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#checkout-payment-header')).toHaveAttribute('aria-expanded', 'true');
});

test('editing Shipping after reopening it locks Payment again until Next Step re-validates (FR)', async ({ page }) => {
  await reachPayment(page, uniqueEmail('editlock'), 'fr');

  await page.click('#checkout-shipping-header');
  await expect(page.locator('#checkout-shipping-header')).toHaveAttribute('aria-expanded', 'true');
  // A genuine data change -- a different city.
  await page.fill('[name="city"]', 'Lyon');

  await expect(page.locator('#checkout-payment-header')).toBeDisabled();

  // Next Step re-validates Shipping and makes Payment reachable again.
  await page.click('#checkout-shipping-next-btn');
  await expect(page.locator('#checkout-payment-header')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#checkout-payment-header')).toBeEnabled();
});

test('reopening a completed step and closing it via a different header never left Payment\'s data stale (EN)', async ({ page }) => {
  await reachPayment(page, uniqueEmail('noop'));

  // Reopen Account, change nothing, go back to Shipping's header, then
  // straight to Payment -- none of this is a real data change anywhere.
  await page.click('#checkout-account-header');
  await page.click('#checkout-shipping-header');
  await expect(page.locator('#checkout-payment-header')).toBeEnabled();
  await page.click('#checkout-payment-header');
  await expect(page.locator('#checkout-payment-header')).toHaveAttribute('aria-expanded', 'true');
});

test('collapsed step summary renders as its own full-width second line with the right content (EN, desktop)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const email = uniqueEmail('summarydesktop');
  await reachPayment(page, email);

  const accountSummary = page.locator('#checkout-account-header-summary');
  const shippingSummary = page.locator('#checkout-shipping-header-summary');
  const paymentSummary = page.locator('#checkout-payment-header-summary');

  await expect(accountSummary).toHaveText(`${email} (Guest)`);
  await expect(shippingSummary).toHaveText('Shipping to: Jean Dupont, 75001 Paris');
  // Payment never gets a summary line at all (point 3's own spec) -- :empty
  // hides it outright rather than showing an empty second line.
  await expect(paymentSummary).toBeHidden();

  // Second line, full width: below the title row, same left edge, and wide
  // enough that it's genuinely using the available width rather than a
  // squeezed-in fragment next to the title.
  const headerBox = await page.locator('#checkout-shipping-header').boundingBox();
  const rowBox = await page.locator('#checkout-shipping-header .checkout-accordion-header-row').boundingBox();
  const summaryBox = await shippingSummary.boundingBox();
  expect(summaryBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 1);
  expect(Math.abs(summaryBox.x - headerBox.x)).toBeLessThan(2);
  expect(summaryBox.width).toBeGreaterThan(headerBox.width * 0.7);

  // The chevron stays on the title row, not pushed down onto the summary line.
  const chevronBox = await page.locator('#checkout-shipping-header .checkout-accordion-chevron').boundingBox();
  const titleBox = await page.locator('#checkout-shipping-header .checkout-accordion-title').boundingBox();
  expect(Math.abs(chevronBox.y - titleBox.y)).toBeLessThan(10);
});

test('collapsed step summary holds at 390px with no page overflow (FR)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const email = uniqueEmail('summary390');
  await reachPayment(page, email, 'fr');

  const shippingSummary = page.locator('#checkout-shipping-header-summary');
  await expect(shippingSummary).toHaveText('Livraison à : Jean Dupont, 75001 Paris');

  const box = await shippingSummary.boundingBox();
  expect(box.width).toBeLessThanOrEqual(390 - 32);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
