// Cart-reminder restore link specs -- checkout.html?restore=1&qty=N&promo=CODE
// (built by supabase/functions/send-abandoned-cart-reminders/email.ts's
// cartRestoreUrl()), handled by js/checkout-page.js's cartRestoreRequest /
// runCartRestoreRequest() and js/cart.js's whenStockKnown().
//
// Same offline setup as tests/checkout-accordion.spec.js: the real Supabase
// SDK and Stripe.js are blocked and replaced by tests/supabase-mock.js /
// tests/stripe-mock.js. validate-promo-code is answered by the mock's own
// window.__mock.promoCodes map, set before the page loads.
//
// Covers:
//  - an empty cart is restored with the emailed quantity (qty=2);
//  - the stock ceiling still clamps the restored quantity;
//  - a cart that already has items is kept as is;
//  - a valid code is applied through the normal promo flow (success message);
//  - an invalid/expired code shows the normal error and the page still works;
//  - restore/qty/promo are removed from the URL (utm_* kept), so a reload
//    re-applies nothing;
//  - the ?expressSuccess=1 confirmation path ignores the params entirely.
const { test, expect } = require('@playwright/test');
const { SUPABASE_CDN_URL, installSupabaseMock } = require('./supabase-mock');
const { STRIPE_CDN_URL, installStripeMock } = require('./stripe-mock');

const UTM = 'utm_source=email&utm_medium=email&utm_campaign=cart_reminder_2';
const PRODUCT_ID = 'monark-edp-100ml';

test.beforeEach(async ({ page }) => {
  await page.route(SUPABASE_CDN_URL, (route) => route.abort());
  await page.route(STRIPE_CDN_URL, (route) => route.abort());
  await page.route('https://maps.googleapis.com/**', (route) => route.abort());
  await page.addInitScript(installSupabaseMock);
  await page.addInitScript(installStripeMock);
  await page.addInitScript(() => { localStorage.setItem('monark_lang', 'en'); });
});

// Runs after installSupabaseMock (init scripts run in registration order),
// so it can configure window.__mock before any page script reads it.
async function configureMock(page, config) {
  await page.addInitScript((c) => { Object.assign(window.__mock, c); }, config);
}

const cartItems = (page) => page.evaluate(() => window.MonarkCart.getCart());
const appliedCode = (page) => page.evaluate(() => window.MonarkCart.getAppliedPromoCode());

async function expectParamsStripped(page) {
  const url = new URL(page.url());
  expect(url.pathname).toBe('/checkout.html');
  expect(url.searchParams.has('restore')).toBe(false);
  expect(url.searchParams.has('qty')).toBe(false);
  expect(url.searchParams.has('promo')).toBe(false);
  // GA4 attribution params are deliberately kept.
  expect(url.searchParams.get('utm_campaign')).toBe('cart_reminder_2');
}

test('empty cart is restored with the emailed quantity, params removed from the URL', async ({ page }) => {
  await page.goto(`/checkout.html?restore=1&qty=2&${UTM}`);
  await expect.poll(() => cartItems(page)).toEqual([{ productId: PRODUCT_ID, quantity: 2 }]);
  await expectParamsStripped(page);
  // Empty-cart banner goes away once the cart is restored.
  await expect(page.locator('#checkout-empty-banner')).toBeHidden();
});

test('restored quantity is clamped to the live stock', async ({ page }) => {
  await configureMock(page, { productRow: { stock_remaining: 3 } });
  await page.goto(`/checkout.html?restore=1&qty=5&${UTM}`);
  await expect.poll(() => cartItems(page)).toEqual([{ productId: PRODUCT_ID, quantity: 3 }]);
});

test('a cart that already has items is kept as is', async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem('monark_cart', JSON.stringify([{ productId: id, quantity: 1 }]));
  }, PRODUCT_ID);
  await page.goto(`/checkout.html?restore=1&qty=3&${UTM}`);
  await expectParamsStripped(page);
  // Give the async restore time to (not) act.
  await page.waitForTimeout(300);
  expect(await cartItems(page)).toEqual([{ productId: PRODUCT_ID, quantity: 1 }]);
});

test('a valid code from the link is applied through the normal promo flow', async ({ page }) => {
  await configureMock(page, { promoCodes: { 'BACK5-TEST42': 5 } });
  await page.goto(`/checkout.html?restore=1&qty=1&promo=BACK5-TEST42&${UTM}`);
  await expect.poll(() => appliedCode(page)).toBe('BACK5-TEST42');
  await expect(page.locator('#checkout-promo-message')).toHaveText('Applied ✓ 5% off');
  await expect(page.locator('#checkout-mobile-promo-message')).toHaveText('Applied ✓ 5% off');
  await expect(page.locator('#checkout-promo-input')).toHaveValue('BACK5-TEST42');
  // Validated server-side, exactly like a manual entry.
  const calls = await page.evaluate(() => window.__mock.invokeLog.filter((c) => c.name === 'validate-promo-code'));
  expect(calls).toEqual([{ name: 'validate-promo-code', body: { code: 'BACK5-TEST42' } }]);
  expect(await cartItems(page)).toEqual([{ productId: PRODUCT_ID, quantity: 1 }]);
  await expectParamsStripped(page);
});

test('an invalid or expired code shows the normal error and the page keeps working', async ({ page }) => {
  await configureMock(page, { promoCodes: {} });
  await page.goto(`/checkout.html?restore=1&qty=2&promo=BACK5-EXPIRED&${UTM}`);
  await expect(page.locator('#checkout-promo-message')).toHaveText('Invalid code');
  await expect(page.locator('#checkout-promo-message')).toHaveClass(/promo-message-error/);
  expect(await appliedCode(page)).toBeNull();
  // Cart still restored, checkout still usable.
  expect(await cartItems(page)).toEqual([{ productId: PRODUCT_ID, quantity: 2 }]);
  await expect(page.locator('#checkout-account-email-input')).toBeEditable();
  await expectParamsStripped(page);
});

test('a reload after restoring re-applies nothing', async ({ page }) => {
  await configureMock(page, { promoCodes: { 'BACK5-TEST42': 5 } });
  await page.goto(`/checkout.html?restore=1&qty=2&promo=BACK5-TEST42&${UTM}`);
  await expect.poll(() => appliedCode(page)).toBe('BACK5-TEST42');
  await page.evaluate(() => { window.MonarkCart.clearCart(); window.MonarkCart.removePromoCode(); });
  await page.reload();
  await page.waitForTimeout(300);
  expect(await cartItems(page)).toEqual([]);
  expect(await appliedCode(page)).toBeNull();
  const calls = await page.evaluate(() => window.__mock.invokeLog.filter((c) => c.name === 'validate-promo-code'));
  expect(calls).toEqual([]);
});

test('the expressSuccess confirmation path ignores the restore params', async ({ page }) => {
  await configureMock(page, { promoCodes: { 'BACK5-TEST42': 5 } });
  await page.goto('/checkout.html?expressSuccess=1&total=149&restore=1&qty=2&promo=BACK5-TEST42');
  await expect(page.locator('#checkout-confirmation')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await cartItems(page)).toEqual([]);
  expect(await appliedCode(page)).toBeNull();
  // Not touched at all on this path.
  expect(new URL(page.url()).searchParams.get('restore')).toBe('1');
});
