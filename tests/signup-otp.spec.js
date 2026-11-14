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
  await expect(page.locator('#checkout-account-create-firstname')).toBeVisible();
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
  await expect(page.getByText('Entrez le code envoyé à')).toBeVisible();

  await typeCode(page, '123456');

  await expect(page.locator('#checkout-account-status')).toBeVisible();
  await expect(page.locator('#checkout-account-status-text')).toContainText(email);
  await expect(page.locator('#checkout-account-created-note')).toBeVisible();
  await expect(page.locator('#checkout-account-created-note')).toHaveText('Votre compte a été créé.');
  await expect(page.locator('#checkout-account-code')).toBeHidden();
  // No navigation happened -- same document, same page.
  expect(page.url()).toContain('/account.html');
});

test('wrong code shows the remaining-attempts message and clears the boxes (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('wrong');
  await startSignup(page, email);

  await page.evaluate(() => { window.__mock.verifyOtpError = { message: 'Invalid token', status: 403 }; });
  await typeCode(page, '000000');

  await expect(page.locator('#checkout-account-code-status')).toHaveText('Incorrect code. You have 2 attempts left.');
  await expect(page.locator('#checkout-account-code')).toBeVisible();
  const values = await page.locator('.checkout-account-code-box').evaluateAll((els) => els.map((el) => el.value));
  expect(values.join('')).toBe('');
  await expect(page.locator('.checkout-account-code-box').first()).toBeFocused();
});

test('expired code shows its own message, with a live cooldown countdown while still cooling down (FR)', async ({ page }) => {
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('expired');
  await startSignup(page, email);

  await page.evaluate(() => { window.__mock.verifyOtpError = { message: 'Token has expired', status: 403 }; });
  await typeCode(page, '111111');

  // startSignup() just sent a fresh code -- the 30s cooldown is still
  // running, so this is the "Xs" wording, not the final "ci-dessous" one
  // (see the dedicated live-countdown test below for the transition).
  await expect(page.locator('#checkout-account-code-status')).toHaveText(/Vous pourrez en demander un nouveau dans \d+ s\./);
});

test('too many attempts (rate limit) on verify shows a clear message and keeps the typed code, without counting as an attempt (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('ratelimit');
  await startSignup(page, email);

  await page.evaluate(() => { window.__mock.verifyOtpError = { message: 'rate limit exceeded', status: 429 }; });
  await typeCode(page, '222222');

  await expect(page.locator('#checkout-account-code-status')).toHaveText('Too many attempts right now. Please wait a few minutes and try again.');
  // Unlike a wrong/expired code, a rate limit doesn't mean the digits
  // themselves are wrong -- they're left in place rather than wiped, and
  // the box/button are re-enabled (not counted toward the 3-attempt lockout).
  const values = await page.locator('.checkout-account-code-box').evaluateAll((els) => els.map((el) => el.value));
  expect(values.join('')).toBe('222222');
  await expect(page.locator('.checkout-account-code-box').first()).toBeEnabled();
});

test('a network error during verification shows a clear message (FR)', async ({ page }) => {
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('network');
  await startSignup(page, email);

  await page.evaluate(() => { window.__mock.verifyOtpThrows = true; });
  await typeCode(page, '333333');

  await expect(page.locator('#checkout-account-code-status')).toHaveText('Erreur réseau. Veuillez vérifier votre connexion et réessayer.');
});

test('a server-side weak-password rejection shows the same clear password message (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('weakpw');
  await submitEmailStep(page, email);
  await expect(page.locator('#checkout-account-create-firstname')).toBeVisible();
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

test('3 wrong attempts locks the step; resend after the cooldown resets attempts and unlocks it (EN)', async ({ page }) => {
  test.setTimeout(30000);
  await page.clock.install();
  await gotoAccount(page, 'en');
  const email = uniqueEmail('lockout');
  await startSignup(page, email);
  await page.evaluate(() => { window.__mock.verifyOtpError = { message: 'Invalid token', status: 403 }; });

  const status = page.locator('#checkout-account-code-status');
  await typeCode(page, '111111');
  await expect(status).toHaveText('Incorrect code. You have 2 attempts left.');
  await typeCode(page, '222222');
  await expect(status).toHaveText('Incorrect code. You have 1 attempt left.');
  await typeCode(page, '333333');
  await expect(status).toHaveText('Too many attempts. Please request a new code.');

  // Boxes and Valider stay disabled while locked.
  const boxes = page.locator('.checkout-account-code-box');
  const allDisabled = await boxes.evaluateAll((els) => els.every((el) => el.disabled));
  expect(allDisabled).toBe(true);
  await expect(page.locator('#checkout-account-code-submit-btn')).toBeDisabled();

  // Resend only becomes available once the real cooldown elapses --
  // independent of the lockout above.
  const resendBtn = page.locator('#checkout-account-code-resend-btn');
  await expect(resendBtn).toBeDisabled();
  await page.clock.runFor(35000);
  await expect(resendBtn).toBeEnabled({ timeout: 15000 });

  await resendBtn.click();
  await expect(status).toHaveText('A new code has been sent.');
  // Sending a new code resets the attempts and clears the boxes.
  const valuesAfterResend = await boxes.evaluateAll((els) => els.map((el) => el.value));
  expect(valuesAfterResend.join('')).toBe('');
  const enabledAfterResend = await boxes.evaluateAll((els) => els.every((el) => !el.disabled));
  expect(enabledAfterResend).toBe(true);

  // A fresh, correct code now succeeds -- the lockout is genuinely gone,
  // not just visually reset.
  await page.evaluate(() => { window.__mock.verifyOtpError = null; });
  await typeCode(page, '444444');
  await expect(page.locator('#checkout-account-status')).toBeVisible();
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
  await expect(page.locator('#checkout-account-code-status')).toHaveText('A new code has been sent.');
  await expect(resendBtn).toBeDisabled();
  await expect(resendBtn).toHaveText(/Resend code \(\d+s\)/);
});

test('an expired code shows a live countdown that switches to the final message once resend is available (FR)', async ({ page }) => {
  test.setTimeout(30000);
  await page.clock.install();
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('expiredcountdown');
  await startSignup(page, email);
  await page.evaluate(() => { window.__mock.verifyOtpError = { message: 'Token has expired', status: 403 }; });
  await typeCode(page, '555555');

  const status = page.locator('#checkout-account-code-status');
  await expect(status).toHaveText(/Vous pourrez en demander un nouveau dans \d+ s\./);
  const firstText = await status.textContent();

  await page.clock.runFor(5000);
  // The countdown number itself must have moved on -- a live update, not a
  // one-time message that just sits there for the whole cooldown.
  await expect(async () => {
    expect(await status.textContent()).not.toBe(firstText);
  }).toPass({ timeout: 15000 });
  await expect(status).toHaveText(/Vous pourrez en demander un nouveau dans \d+ s\./);

  await page.clock.runFor(30000);
  await expect(status).toHaveText('Ce code a expiré. Demandez-en un nouveau ci-dessous.', { timeout: 15000 });
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
  const attemptsKey = await page.evaluate(() => sessionStorage.getItem('monark_signup_otp_attempts'));
  expect(attemptsKey).toBeNull();
});

test('accessibility: hidden group label, per-digit labels, aria-live status region, and initial focus (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('a11y');
  await startSignup(page, email);

  // Still in the accessibility tree (a screen reader gets a group label)
  // but visually hidden -- "6-digit code" is no longer shown on screen,
  // see the legend's own CSS comment.
  const legend = page.locator('.checkout-account-code-legend');
  await expect(legend).toHaveText('6-digit code');
  const legendBox = await legend.boundingBox();
  expect(legendBox.width).toBeLessThanOrEqual(1);
  expect(legendBox.height).toBeLessThanOrEqual(1);

  await expect(page.locator('#checkout-account-code-status')).toHaveAttribute('aria-live', 'polite');
  const boxes = page.locator('.checkout-account-code-box');
  await expect(boxes.nth(0)).toHaveAttribute('aria-label', 'Digit 1 of 6');
  await expect(boxes.nth(5)).toHaveAttribute('aria-label', 'Digit 6 of 6');
  await expect(boxes.nth(0)).toBeFocused();
  await expect(boxes.nth(0)).toHaveAttribute('autocomplete', 'one-time-code');
});

test('code step layout: centered, smaller boxes at desktop and at exactly 390px width (EN)', async ({ page }) => {
  // Explicit desktop size regardless of the project's own default viewport
  // -- the Mobile Chrome project's default (Pixel 7, ~412px) is already
  // close enough to the 420px breakpoint that relying on "whatever this
  // project starts at" would assert the SMALL box size here by accident.
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoAccount(page, 'en');
  const email = uniqueEmail('layout');
  await startSignup(page, email);

  // Desktop: ~40x48px boxes, horizontally centered under the gate.
  const boxDesktop = await page.locator('.checkout-account-code-box').first().boundingBox();
  expect(boxDesktop.width).toBeGreaterThanOrEqual(38);
  expect(boxDesktop.width).toBeLessThanOrEqual(42);
  expect(boxDesktop.height).toBeGreaterThanOrEqual(46);
  expect(boxDesktop.height).toBeLessThanOrEqual(50);

  const boxesRow = await page.locator('.checkout-account-code-boxes').boundingBox();
  const gate = await page.locator('#account-gate').boundingBox();
  const rowCenter = boxesRow.x + boxesRow.width / 2;
  const gateCenter = gate.x + gate.width / 2;
  expect(Math.abs(rowCenter - gateCenter)).toBeLessThan(5);

  // Valider and the Resend/Modify row are centered too.
  const submitBtnBox = await page.locator('#checkout-account-code-submit-btn').boundingBox();
  expect(Math.abs((submitBtnBox.x + submitBtnBox.width / 2) - gateCenter)).toBeLessThan(5);

  // 390px: ~36x44px boxes, still no horizontal overflow anywhere on the page.
  await page.setViewportSize({ width: 390, height: 844 });
  const box390 = await page.locator('.checkout-account-code-box').first().boundingBox();
  expect(box390.width).toBeGreaterThanOrEqual(34);
  expect(box390.width).toBeLessThanOrEqual(38);
  expect(box390.height).toBeGreaterThanOrEqual(42);
  expect(box390.height).toBeLessThanOrEqual(46);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a session event firing while verification is pending never overrides the code step, and keeps the typed digits (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('tabswitch');
  await startSignup(page, email);

  // Partial digits only -- not a complete code, so nothing auto-submits.
  await page.locator('.checkout-account-code-box').first().click();
  await page.keyboard.type('123');

  // Simulates exactly what the real bug report described: the customer
  // switches away to their mail app/tab and back, and in the background
  // supabase-js re-fires a SIGNED_IN/TOKEN_REFRESHED notification for some
  // OTHER, previously-active session on this browser (its own
  // _onVisibilityChanged() -> _recoverAndRefresh(), confirmed in this
  // file's own account.js comments elsewhere) -- completely unrelated to
  // the signup still pending here.
  await page.evaluate(() => {
    window.__mock.fireAuthEvent('SIGNED_IN', { user: { id: 'other-uid', email: 'someoneelse@example.com' } });
  });
  // A real visibilitychange too, for good measure -- nothing in this file
  // listens for it directly, but it shouldn't trigger anything either.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  await expect(page.locator('#checkout-account-code')).toBeVisible();
  await expect(page.locator('#checkout-account-code-email')).toHaveText(email);
  const values = await page.locator('.checkout-account-code-box').evaluateAll((els) => els.map((el) => el.value));
  expect(values.join('')).toBe('123');
  // Must NOT have jumped to "logged in as someoneelse@example.com".
  await expect(page.locator('#checkout-account-status')).toBeHidden();

  // The step still works normally afterward.
  await page.keyboard.type('456');
  await expect(page.locator('#checkout-account-status')).toBeVisible();
  await expect(page.locator('#checkout-account-status-text')).toContainText(email);
});

test('a logged-in customer creating a new account for a different email signs out first and still uses signUp, never updateUser (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const oldEmail = uniqueEmail('old');
  // Establishes a real, already-resolved session for a DIFFERENT account --
  // the exact state modifyEmailBtn's own cancelable edit mode deliberately
  // leaves intact (see enterEmailEditMode()'s comment in js/account.js).
  await page.evaluate((e) => {
    window.__mock.fireAuthEvent('SIGNED_IN', { user: { id: 'old-uid', email: e } });
  }, oldEmail);
  await expect(page.locator('#checkout-account-status-text')).toContainText(oldEmail);

  await page.click('#checkout-account-modify-email-btn');
  const newEmail = uniqueEmail('new');
  await submitEmailStep(page, newEmail);
  await expect(page.locator('#checkout-account-create-firstname')).toBeVisible();
  await fillCreateForm(page);
  await page.click('#checkout-account-create-submit-btn');

  await expect(page.locator('#checkout-account-code')).toBeVisible();
  await expect(page.locator('#checkout-account-code-email')).toHaveText(newEmail);

  const callLog = await page.evaluate(() => window.__mock.callLog);
  expect(callLog).not.toContain('updateUser');
  expect(callLog).toContain('signOut');
  expect(callLog).toContain('signUp');
  // signOut happened BEFORE this signUp -- not just somewhere in the log.
  expect(callLog.indexOf('signOut')).toBeLessThan(callLog.lastIndexOf('signUp'));
});

test('logging in with an unconfirmed email resends a code and moves to the code step instead of "wrong password" (FR)', async ({ page }) => {
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('unconfirmed');
  await page.evaluate(() => { window.__mock.emailExists = true; });
  await submitEmailStep(page, email);
  await expect(page.locator('#checkout-account-login-password')).toBeVisible();

  await page.evaluate(() => {
    window.__mock.signInError = { message: 'Email not confirmed', code: 'email_not_confirmed', status: 400 };
  });
  await page.fill('#checkout-account-login-password', 'whatever-does-not-matter');
  await page.click('#checkout-account-login-submit-btn');

  await expect(page.locator('#checkout-account-code')).toBeVisible();
  await expect(page.locator('#checkout-account-code-email')).toHaveText(email);
  await expect(page.locator('#checkout-account-code-status')).toHaveText(
    "Cet e-mail n'est pas encore vérifié. Nous venons de vous envoyer un nouveau code."
  );
  await expect(page.locator('#checkout-account-login-error')).toBeHidden();

  // A real wrong password (not the email_not_confirmed case) must still
  // say so, not silently move to the code step.
  await page.click('#checkout-account-code-modify-email-btn');
  await submitEmailStep(page, email);
  await page.evaluate(() => {
    window.__mock.signInError = { message: 'Invalid login credentials', status: 400 };
  });
  await page.fill('#checkout-account-login-password', 'wrong-password');
  await page.click('#checkout-account-login-submit-btn');
  await expect(page.locator('#checkout-account-login-error')).toHaveText('Mot de passe incorrect.');
  await expect(page.locator('#checkout-account-code')).toBeHidden();
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
