// Email-code (OTP) account creation -- exercises js/account.js's shared
// mountAccountGate() code step (createAccount() -> verifySignupOtp()/
// resendSignupOtp()) with the real Supabase JS SDK blocked and replaced by
// tests/supabase-mock.js's own fake window.MonarkSupabase. Primarily driven
// through account.html (no cart/accordion setup needed, createForm
// auto-expands there -- see mountAccountGate()'s hideGuestOption), with one
// smoke test confirming checkout.html's own account-gate step shows the
// exact same code step (the two pages share this one implementation).
const { test, expect } = require('@playwright/test');
const { SUPABASE_CDN_URL, installSupabaseMock } = require('./supabase-mock');

const PASSWORD = 'Passw0rd!';

test.beforeEach(async ({ page }) => {
  // Blocking this is what lets the mock installed below survive --
  // js/supabase-client.js only backs off from overwriting
  // window.MonarkSupabase when the real SDK never loaded (see that file's
  // own guard, and supabase-mock.js's header comment).
  await page.route(SUPABASE_CDN_URL, (route) => route.abort());
  await page.addInitScript(installSupabaseMock);
});

async function gotoAccount(page, lang) {
  await page.addInitScript((l) => { localStorage.setItem('monark_lang', l); }, lang);
  await page.goto('/account.html');
}

async function submitEmailStep(page, email) {
  await page.fill('#checkout-account-email-input', email);
  await page.click('#checkout-account-email-submit-btn');
  await expect(page.locator('#checkout-account-create-firstname')).toBeVisible();
}

async function fillCreateForm(page, { firstName = 'Jean', lastName = 'Dupont', password = PASSWORD } = {}) {
  await page.fill('#checkout-account-create-firstname', firstName);
  await page.fill('#checkout-account-create-lastname', lastName);
  await page.fill('#checkout-account-create-password', password);
  await page.fill('#checkout-account-create-confirm', password);
}

// Takes the gate all the way from a brand-new email to the code step
// (account.html's own hideGuestOption auto-expands createForm -- no
// "Create an account instead" toggle to click first, unlike checkout.html).
async function startSignup(page, email, opts) {
  await submitEmailStep(page, email);
  await fillCreateForm(page, opts);
  await page.click('#checkout-account-create-submit-btn');
  await expect(page.locator('#checkout-account-code')).toBeVisible();
}

// Clicks the first box, then types every digit in one go -- relies on the
// boxes' own auto-advance (js/account.js's codeBoxes 'input' listener) to
// land each subsequent keystroke in the right box, exactly like a real
// customer typing the code digit by digit.
async function typeCode(page, digits) {
  await page.locator('.checkout-account-code-box').first().click();
  await page.keyboard.type(digits);
}

function uniqueEmail(tag) {
  return `${tag}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
}

test('happy path: signup, verify the code, account is shown with no page reload (FR)', async ({ page }) => {
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('happy');
  await startSignup(page, email);
  await expect(page.locator('#checkout-account-code-email')).toHaveText(email);
  await expect(page.getByText('Entrez le code reçu par e-mail')).toBeVisible();

  await typeCode(page, '123456');

  await expect(page.locator('#checkout-account-status')).toBeVisible();
  await expect(page.locator('#checkout-account-status-text')).toContainText(email);
  await expect(page.locator('#checkout-account-created-note')).toBeVisible();
  await expect(page.locator('#checkout-account-created-note')).toHaveText('Votre compte a été créé.');
  await expect(page.locator('#checkout-account-code')).toBeHidden();
  // No navigation happened -- same document, same page.
  expect(page.url()).toContain('/account.html');
});

test('wrong code shows a clear, distinct error and clears the boxes (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('wrong');
  await startSignup(page, email);

  await page.evaluate(() => { window.__mock.verifyOtpError = { message: 'Invalid token', status: 403 }; });
  await typeCode(page, '000000');

  await expect(page.locator('#checkout-account-code-error')).toHaveText('Incorrect code. Please check and try again.');
  await expect(page.locator('#checkout-account-code')).toBeVisible();
  const values = await page.locator('.checkout-account-code-box').evaluateAll((els) => els.map((el) => el.value));
  expect(values.join('')).toBe('');
  await expect(page.locator('.checkout-account-code-box').first()).toBeFocused();
});

test('expired code shows its own distinct error (FR)', async ({ page }) => {
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('expired');
  await startSignup(page, email);

  await page.evaluate(() => { window.__mock.verifyOtpError = { message: 'Token has expired', status: 403 }; });
  await typeCode(page, '111111');

  await expect(page.locator('#checkout-account-code-error')).toHaveText('Ce code a expiré. Demandez-en un nouveau ci-dessous.');
});

test('too many attempts (rate limit) on verify shows a clear message and keeps the typed code (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('ratelimit');
  await startSignup(page, email);

  await page.evaluate(() => { window.__mock.verifyOtpError = { message: 'rate limit exceeded', status: 429 }; });
  await typeCode(page, '222222');

  await expect(page.locator('#checkout-account-code-error')).toHaveText('Too many attempts right now. Please wait a few minutes and try again.');
  // Unlike a wrong/expired code, a rate limit doesn't mean the digits
  // themselves are wrong -- they're left in place rather than wiped.
  const values = await page.locator('.checkout-account-code-box').evaluateAll((els) => els.map((el) => el.value));
  expect(values.join('')).toBe('222222');
});

test('a network error during verification shows a clear message (FR)', async ({ page }) => {
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('network');
  await startSignup(page, email);

  await page.evaluate(() => { window.__mock.verifyOtpThrows = true; });
  await typeCode(page, '333333');

  await expect(page.locator('#checkout-account-code-error')).toHaveText('Erreur réseau. Veuillez vérifier votre connexion et réessayer.');
});

test('a server-side weak-password rejection shows the same clear password message (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('weakpw');
  await submitEmailStep(page, email);
  // A password that passes the client-side isValidPassword() check but is
  // rejected server-side (e.g. Supabase's own known-weak/pwned list).
  await fillCreateForm(page, { password: 'Str0ng!ish' });
  await page.evaluate(() => {
    window.__mock.signUpError = { message: 'Password is known to be weak and easy to guess', code: 'weak_password', status: 422 };
  });
  await page.click('#checkout-account-create-submit-btn');

  await expect(page.locator('#checkout-account-create-error')).toHaveText(
    'Password must be at least 8 characters and include a letter, a number, and a special character (! @ # $ % & *).'
  );
  await expect(page.locator('#checkout-account-code')).toBeHidden();
});

test('resend code: disabled with a visible countdown, then succeeds (EN)', async ({ page }) => {
  // Driving the countdown's real setInterval ticks through page.clock.runFor()
  // needs the browser to actually execute each one -- under a fully
  // parallel run (every project/test sharing the machine's CPU) that can
  // take longer than the default 5s expect timeout, and the clock/
  // navigation handoff itself can occasionally let a tick or two of real
  // time slip in before the fake clock takes hold. A longer test timeout
  // plus asserting "disabled with SOME countdown number" rather than the
  // exact starting value is what actually makes this robust under load --
  // the real behavior under test (disabled right after a send, a visible
  // countdown, eventual re-enable, a working resend) is still fully covered.
  test.setTimeout(30000);
  await page.clock.install();
  await gotoAccount(page, 'en');
  const email = uniqueEmail('resend');
  await startSignup(page, email);

  const resendBtn = page.locator('#checkout-account-code-resend-btn');
  await expect(resendBtn).toBeDisabled();
  await expect(resendBtn).toHaveText(/Resend code \(\d+s\)/);

  // runFor (not fastForward) -- fastForward jumps the clock and fires each
  // due timer at most once, which would skip the countdown's own repeating
  // setInterval ticks; runFor simulates the intervening time passing
  // normally, firing every 1-second tick along the way. 35s (not exactly
  // 30s) covers the odd second of real time that can slip in before the
  // fake clock takes hold (see above) without ever risking under-shooting.
  await page.clock.runFor(35000);
  // Explicit, longer timeout on this one assertion -- see test.setTimeout()
  // above for why: the simulated ticks runFor() just fired still need real
  // wall-clock time for the browser to actually execute, which a fully
  // parallel run can push past the default 5s expect timeout.
  await expect(resendBtn).toBeEnabled({ timeout: 15000 });
  await expect(resendBtn).toHaveText('Resend code');

  await resendBtn.click();
  await expect(page.locator('#checkout-account-code-resend-status')).toHaveText('A new code has been sent.');
  await expect(resendBtn).toBeDisabled();
  await expect(resendBtn).toHaveText(/Resend code \(\d+s\)/);
});

test('pasting the full 6-digit code fills every box and auto-submits (FR)', async ({ page }) => {
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('paste');
  await startSignup(page, email);

  await page.locator('.checkout-account-code-box').first().click();
  await page.evaluate(() => {
    const box = document.querySelectorAll('.checkout-account-code-box')[0];
    const dt = new DataTransfer();
    dt.setData('text', '987654');
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    box.dispatchEvent(event);
  });

  const values = await page.locator('.checkout-account-code-box').evaluateAll((els) => els.map((el) => el.value));
  expect(values.join('')).toBe('987654');
  await expect(page.locator('#checkout-account-status')).toBeVisible();
});

test('reloading mid-verification returns to the code step, email only (never the password) (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('reload');
  await startSignup(page, email);

  const pendingEmail = await page.evaluate(() => sessionStorage.getItem('monark_signup_otp_pending_email'));
  expect(pendingEmail).toBe(email);
  const wholeSessionStorage = await page.evaluate(() => JSON.stringify(sessionStorage));
  expect(wholeSessionStorage).not.toContain(PASSWORD);

  await page.reload();

  await expect(page.locator('#checkout-account-code')).toBeVisible();
  await expect(page.locator('#checkout-account-code-email')).toHaveText(email);

  // Verification still works normally after the reload.
  await typeCode(page, '555555');
  await expect(page.locator('#checkout-account-status')).toBeVisible();
  const pendingAfterVerify = await page.evaluate(() => sessionStorage.getItem('monark_signup_otp_pending_email'));
  expect(pendingAfterVerify).toBeNull();
});

test('Modify Email from the code step returns to the email form, prefilled, and clears the pending state (FR)', async ({ page }) => {
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('modify');
  await startSignup(page, email);

  await page.click('#checkout-account-code-modify-email-btn');

  await expect(page.locator('#checkout-account-email-input')).toHaveValue(email);
  await expect(page.locator('#checkout-account-code')).toBeHidden();
  const pendingEmail = await page.evaluate(() => sessionStorage.getItem('monark_signup_otp_pending_email'));
  expect(pendingEmail).toBeNull();
});

test('accessibility: group label, per-digit labels, aria-live error region, and initial focus (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('a11y');
  await startSignup(page, email);

  await expect(page.locator('.checkout-account-code-legend')).toHaveText('6-digit code');
  await expect(page.locator('#checkout-account-code-error')).toHaveAttribute('aria-live', 'polite');
  const boxes = page.locator('.checkout-account-code-box');
  await expect(boxes.nth(0)).toHaveAttribute('aria-label', 'Digit 1 of 6');
  await expect(boxes.nth(5)).toHaveAttribute('aria-label', 'Digit 6 of 6');
  await expect(boxes.nth(0)).toBeFocused();
  await expect(boxes.nth(0)).toHaveAttribute('autocomplete', 'one-time-code');
});

test('the code step fits at exactly 390px width with no horizontal overflow (EN)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoAccount(page, 'en');
  const email = uniqueEmail('w390');
  await startSignup(page, email);

  await expect(page.locator('.checkout-account-code-boxes')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const boxesBox = await page.locator('.checkout-account-code-boxes').boundingBox();
  expect(boxesBox.x + boxesBox.width).toBeLessThanOrEqual(390);
});

test('the same OTP code step also appears on checkout.html (shared gate) (EN)', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('monark_lang', 'en'); });
  await page.goto('/checkout.html');
  const email = uniqueEmail('checkoutgate');

  await page.fill('#checkout-account-email-input', email);
  await page.click('#checkout-account-email-submit-btn');
  // checkout.html (hideGuestOption: false) needs this extra click --
  // account.html auto-expands createForm instead, see startSignup() above.
  await page.click('#checkout-account-create-toggle');
  await fillCreateForm(page);
  await page.click('#checkout-account-create-submit-btn');

  await expect(page.locator('#checkout-account-code')).toBeVisible();
  await typeCode(page, '444444');

  // onResolved (js/checkout-page.js) opens the Shipping step once the
  // account resolves and collapses Account into its own summary button --
  // confirms the flow continued in place, no reload. (checkout-account-status
  // itself is still in the DOM at this point, just inside that now-collapsed
  // Account accordion body, so it isn't the right visibility check here --
  // unlike account.html, which has no accordion to collapse into.)
  await expect(page.locator('#checkout-shipping-header')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#checkout-account-header')).toContainText(email);
});
