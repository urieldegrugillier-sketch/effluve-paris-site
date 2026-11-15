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
const SENT_AT_KEY = 'monark_signup_otp_sent_at';
const PENDING_EMAIL_KEY = 'monark_signup_otp_pending_email';
const ATTEMPTS_KEY = 'monark_signup_otp_attempts';
const OTP_EXPIRY_MS = 600000;

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

// Node-side mirror of js/account.js's own maskEmailForDisplay() -- used
// only to compute the EXPECTED masked string for assertions, kept in sync
// by hand with that function's own exact rule (first char + *** + last 3
// chars of the local part + @domain, or just first char + *** when the
// local part is 4 characters or fewer).
function maskEmailForDisplay(email) {
  const at = email.indexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 4) return local.charAt(0) + '***' + domain;
  return local.charAt(0) + '***' + local.slice(-3) + domain;
}

test('happy path: signup, verify the code, account is shown with no page reload (FR)', async ({ page }) => {
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('happy');
  await startSignup(page, email);
  await expect(page.locator('#checkout-account-code-email')).toHaveText(maskEmailForDisplay(email));
  await expect(page.getByText('Entrez le code envoyé à', { exact: false })).toBeVisible();
  // The real address is never written into the DOM as text.
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain(email);

  await typeCode(page, '123456');

  await expect(page.locator('#checkout-account-status')).toBeVisible();
  await expect(page.locator('#checkout-account-status-text')).toContainText(email);
  await expect(page.locator('#checkout-account-created-note')).toBeVisible();
  await expect(page.locator('#checkout-account-created-note')).toHaveText('Votre compte a été créé.');
  await expect(page.locator('#checkout-account-code')).toBeHidden();
  // No navigation happened -- same document, same page.
  expect(page.url()).toContain('/account.html');
});

test('masked email: a long local part keeps 3 asterisks plus its last 3 characters (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = 'muriel.elise.49@gmail.com';
  await startSignup(page, email);
  await expect(page.locator('#checkout-account-code-email')).toHaveText('m***.49@gmail.com');
});

test('masked email: a local part of 4 characters or fewer collapses to first-char + *** (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  // "abcd" is exactly 4 characters -- the boundary case itself (<=4 means
  // this is the LAST local part length that still collapses to the short
  // form, not the "last 3 chars" form a 5+-character local part would get).
  const email = 'abcd@example.com';
  await startSignup(page, email);
  await expect(page.locator('#checkout-account-code-email')).toHaveText('a***@example.com');
  expect(maskEmailForDisplay(email)).toBe('a***@example.com');
});

test('wrong code (within the valid window) shows the remaining-attempts message, never "expired" (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('wrong');
  await startSignup(page, email);

  // BUG FIX 3's own regression check: Supabase's ambiguous error message
  // literally contains the word "expired" even for a simple wrong digit --
  // this must still be read as "wrong code, attempts left," never as a
  // real expiry, since the code was sent moments ago (well under 600s).
  await page.evaluate(() => { window.__mock.verifyOtpError = { message: 'Token has expired or is invalid', status: 403 }; });
  await typeCode(page, '000000');

  await expect(page.locator('#checkout-account-code-status')).toHaveText('Incorrect code. You have 2 attempts left.');
  await expect(page.locator('#checkout-account-code')).toBeVisible();
  const values = await page.locator('.checkout-account-code-box').evaluateAll((els) => els.map((el) => el.value));
  expect(values.join('')).toBe('');
  await expect(page.locator('.checkout-account-code-box').first()).toBeFocused();
});

test('BUG FIX 3: no error at all during the first 60s cooldown with no failed attempt (EN)', async ({ page }) => {
  test.setTimeout(30000);
  await page.clock.install();
  await gotoAccount(page, 'en');
  const email = uniqueEmail('noerroryet');
  await startSignup(page, email);

  await expect(page.locator('#checkout-account-code-status')).toBeHidden();
  await page.clock.runFor(55000);
  // Still within the (now 60s) cooldown, still no attempt made -- still
  // nothing shown. Explicit, longer timeout -- same reasoning as the other
  // clock-driven tests in this file: the 55 simulated ticks runFor() just
  // fired still need real wall-clock time to actually execute under a
  // fully parallel run, which can occasionally push past the default 5s.
  await expect(page.locator('#checkout-account-code-status')).toBeHidden({ timeout: 15000 });
});

test('BUG FIX 3: a genuinely expired code (>=600s since it was sent) shows the real expiry message (FR)', async ({ page }) => {
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('reallyexpired');
  await startSignup(page, email);

  // Simulates the code having actually been sent 10+ minutes ago -- the
  // 60s resend cooldown computed from the SAME timestamp is necessarily
  // long over by then too, so this always renders the final "ci-dessous"
  // wording directly (never the live "dans Xs" one, which can only ever
  // apply during the first 60s -- i.e. never alongside a real 600s expiry).
  await page.evaluate((key) => {
    sessionStorage.setItem(key, String(Date.now() - 601000));
  }, SENT_AT_KEY);
  await page.evaluate(() => { window.__mock.verifyOtpError = { message: 'Token has expired or is invalid', status: 403 }; });
  await typeCode(page, '111111');

  await expect(page.locator('#checkout-account-code-status')).toHaveText('Ce code a expiré. Demandez-en un nouveau ci-dessous.');
  // Not counted as a wrong-code attempt -- the attempts counter never moves.
  const attemptsUsed = await page.evaluate((key) => sessionStorage.getItem(key), ATTEMPTS_KEY);
  expect(attemptsUsed).toBeNull();
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
  // the boxes are re-enabled (not counted toward the 3-attempt lockout).
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
  test.setTimeout(45000);
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

  // Boxes stay disabled while locked -- no submit button to check any more
  // (removed, see BUG FIX 6 -- the 6th digit's own auto-submit is the only
  // way this step is ever submitted now).
  const boxes = page.locator('.checkout-account-code-box');
  const allDisabled = await boxes.evaluateAll((els) => els.every((el) => el.disabled));
  expect(allDisabled).toBe(true);

  // Resend only becomes available once the real cooldown elapses --
  // independent of the lockout above.
  const resendBtn = page.locator('#checkout-account-code-resend-btn');
  await expect(resendBtn).toBeDisabled();
  await expect(resendBtn).toHaveAttribute('aria-disabled', 'true');
  // 65s (not exactly 60s) covers the odd second of real time that can slip
  // in before the fake clock takes hold, same margin reasoning as the
  // resend-countdown test below.
  await page.clock.runFor(65000);
  await expect(resendBtn).toBeEnabled({ timeout: 20000 });
  await expect(resendBtn).toHaveAttribute('aria-disabled', 'false');

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

test('resend link: greyed out with a live countdown while cooling down, then active (EN)', async ({ page }) => {
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
  test.setTimeout(45000);
  await page.clock.install();
  await gotoAccount(page, 'en');
  const email = uniqueEmail('resend');
  await startSignup(page, email);

  const resendBtn = page.locator('#checkout-account-code-resend-btn');
  await expect(resendBtn).toBeDisabled();
  await expect(resendBtn).toHaveAttribute('aria-disabled', 'true');
  await expect(resendBtn).toHaveText(/Resend code in \d+s/);

  // runFor (not fastForward) -- fastForward jumps the clock and fires each
  // due timer at most once, which would skip the countdown's own repeating
  // setInterval ticks; runFor simulates the intervening time passing
  // normally, firing every 1-second tick along the way. 65s (not exactly
  // 60s, the RESEND_COOLDOWN_SECONDS) covers the odd second of real time
  // that can slip in before the fake clock takes hold (see above) without
  // ever risking under-shooting.
  await page.clock.runFor(65000);
  // Explicit, longer timeout on this one assertion -- see test.setTimeout()
  // above for why: the simulated ticks runFor() just fired still need real
  // wall-clock time for the browser to actually execute, which a fully
  // parallel run can push past the default 5s expect timeout.
  await expect(resendBtn).toBeEnabled({ timeout: 20000 });
  await expect(resendBtn).toHaveAttribute('aria-disabled', 'false');
  await expect(resendBtn).toHaveText('Resend code');

  await resendBtn.click();
  await expect(page.locator('#checkout-account-code-status')).toHaveText('A new code has been sent.');
  await expect(resendBtn).toBeDisabled();
  await expect(resendBtn).toHaveText(/Resend code in \d+s/);
});

// POINT 4: Supabase's own rate limit tripping on a resend click used to
// just show a generic error and re-enable the button immediately -- that
// invited an instant second rate-limited retry. Now the button stays
// disabled for the real wait Supabase just reported.
test('resend button: a rate limit with a known wait disables it for that exact countdown, not the default (EN)', async ({ page }) => {
  test.setTimeout(45000);
  await page.clock.install();
  await gotoAccount(page, 'en');
  const email = uniqueEmail('resendratelimited');
  await startSignup(page, email);

  // Past the initial 60s send cooldown -- same margin reasoning as the
  // other clock-driven tests in this file.
  const resendBtn = page.locator('#checkout-account-code-resend-btn');
  await page.clock.runFor(65000);
  await expect(resendBtn).toBeEnabled({ timeout: 20000 });

  await page.evaluate(() => {
    window.__mock.resendError = { message: 'For security purposes, you can only request this after 12 seconds.', status: 429 };
  });
  await resendBtn.click();

  await expect(page.locator('#checkout-account-code-status')).toHaveText(
    'Too many attempts right now. Please wait a few minutes and try again.'
  );
  await expect(resendBtn).toBeDisabled();
  await expect(resendBtn).toHaveAttribute('aria-disabled', 'true');
  await expect(resendBtn).toHaveText('Resend code in 12s');
});

// The OTHER shape of Supabase's email-sending throttle: the project's
// blunter hourly quota, which gives no specific wait at all -- distinct
// copy (not the generic "too many attempts" one, which would be actively
// misleading here) and the RESEND_COOLDOWN_SECONDS fallback (60s).
test('resend button: the hourly email limit (no seconds given) shows a distinct message and the default 60s cooldown (FR)', async ({ page }) => {
  test.setTimeout(45000);
  await page.clock.install();
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('resendhourly');
  await startSignup(page, email);

  const resendBtn = page.locator('#checkout-account-code-resend-btn');
  await page.clock.runFor(65000);
  await expect(resendBtn).toBeEnabled({ timeout: 20000 });

  await page.evaluate(() => {
    window.__mock.resendError = { message: 'Email rate limit exceeded', code: 'over_email_send_rate_limit', status: 429 };
  });
  await resendBtn.click();

  await expect(page.locator('#checkout-account-code-status')).toHaveText(
    "Trop d'e-mails envoyés pour le moment. Réessayez dans quelques minutes."
  );
  await expect(resendBtn).toBeDisabled();
  await expect(resendBtn).toHaveText('Renvoyer le code dans 60 s');
});

test('signing up during the hourly email limit shows a distinct message, not the generic rate-limit one (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('signuphourly');
  await submitEmailStep(page, email);
  await expect(page.locator('#checkout-account-create-firstname')).toBeVisible();
  await fillCreateForm(page);
  await page.evaluate(() => {
    window.__mock.signUpError = { message: 'Email rate limit exceeded', code: 'over_email_send_rate_limit', status: 429 };
  });
  await page.click('#checkout-account-create-submit-btn');

  await expect(page.locator('#checkout-account-create-error')).toHaveText(
    'Too many emails sent right now. Try again in a few minutes.'
  );
  await expect(page.locator('#checkout-account-code')).toBeHidden();
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

  const pendingEmail = await page.evaluate((key) => sessionStorage.getItem(key), PENDING_EMAIL_KEY);
  expect(pendingEmail).toBe(email);
  const wholeSessionStorage = await page.evaluate(() => JSON.stringify(sessionStorage));
  expect(wholeSessionStorage).not.toContain(PASSWORD);

  await page.reload();

  await expect(page.locator('#checkout-account-code')).toBeVisible();
  await expect(page.locator('#checkout-account-code-email')).toHaveText(maskEmailForDisplay(email));

  // Verification still works normally after the reload.
  await typeCode(page, '555555');
  await expect(page.locator('#checkout-account-status')).toBeVisible();
  const pendingAfterVerify = await page.evaluate((key) => sessionStorage.getItem(key), PENDING_EMAIL_KEY);
  expect(pendingAfterVerify).toBeNull();
});

test('BUG FIX 7: a fresh navigation clears the pending code step instead of restoring it (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('freshnav');
  await startSignup(page, email);
  await expect(page.locator('#checkout-account-code')).toBeVisible();

  // Leaving the page entirely, then coming back via an ordinary navigation
  // (not a reload, not back/forward) -- the Performance Navigation Timing
  // API reports this as 'navigate', the one type that must NOT restore.
  await page.goto('/index.html');
  await page.goto('/account.html');

  await expect(page.locator('#checkout-account-code')).toBeHidden();
  await expect(page.locator('#checkout-account-email-input')).toBeVisible();
  const pendingAfterFreshNav = await page.evaluate((key) => sessionStorage.getItem(key), PENDING_EMAIL_KEY);
  expect(pendingAfterFreshNav).toBeNull();
});

test('BUG FIX 7: a back/forward navigation DOES restore the pending code step (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('backforward');
  await startSignup(page, email);
  await expect(page.locator('#checkout-account-code')).toBeVisible();

  await page.goto('/index.html');
  await page.goBack();

  await expect(page.locator('#checkout-account-code')).toBeVisible();
  await expect(page.locator('#checkout-account-code-email')).toHaveText(maskEmailForDisplay(email));
});

test('BUG FIX 7: a pending state older than 10 minutes is dropped even on a reload (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('stalereload');
  await startSignup(page, email);

  // Backdates the send timestamp past OTP_EXPIRY_MS, simulating the
  // customer coming back to a long-abandoned tab and only THEN reloading --
  // there is nothing left worth restoring for a code that's long dead.
  await page.evaluate(({ key, ms }) => {
    sessionStorage.setItem(key, String(Date.now() - ms - 1000));
  }, { key: SENT_AT_KEY, ms: OTP_EXPIRY_MS });

  await page.reload();

  await expect(page.locator('#checkout-account-code')).toBeHidden();
  await expect(page.locator('#checkout-account-email-input')).toBeVisible();
  const pendingAfterReload = await page.evaluate((key) => sessionStorage.getItem(key), PENDING_EMAIL_KEY);
  expect(pendingAfterReload).toBeNull();
});

test('Modify Email from the code step returns to the email form, prefilled, and clears the pending state (FR)', async ({ page }) => {
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('modify');
  await startSignup(page, email);

  await page.click('#checkout-account-code-modify-email-btn');

  await expect(page.locator('#checkout-account-email-input')).toHaveValue(email);
  await expect(page.locator('#checkout-account-code')).toBeHidden();
  const pendingEmail = await page.evaluate((key) => sessionStorage.getItem(key), PENDING_EMAIL_KEY);
  expect(pendingEmail).toBeNull();
  const attemptsUsed = await page.evaluate((key) => sessionStorage.getItem(key), ATTEMPTS_KEY);
  expect(attemptsUsed).toBeNull();
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

  // No Valider/Verify button anywhere in the step (BUG FIX 6).
  await expect(page.locator('#checkout-account-code button[type="submit"]')).toHaveCount(0);
});

test('code step layout: no Valider button, centered smaller boxes, and >=44px tap targets at desktop and at exactly 390px (EN)', async ({ page }) => {
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

  // Both helper lines (Resend / Modify Email) read as centered text too.
  const line1Box = await page.locator('.checkout-account-code-helper-line').nth(0).boundingBox();
  expect(Math.abs((line1Box.x + line1Box.width / 2) - gateCenter)).toBeLessThan(40);

  // Tap target: the *clickable* link itself (padding included) is >=44px
  // tall, even though the visible text is much smaller -- see
  // .checkout-account-inline-link's own padding/negative-margin comment.
  const resendLinkBox = await page.locator('#checkout-account-code-resend-btn').boundingBox();
  expect(resendLinkBox.height).toBeGreaterThanOrEqual(44);

  // 390px: ~36x44px boxes, still no horizontal overflow anywhere on the page.
  await page.setViewportSize({ width: 390, height: 844 });
  const box390 = await page.locator('.checkout-account-code-box').first().boundingBox();
  expect(box390.width).toBeGreaterThanOrEqual(34);
  expect(box390.width).toBeLessThanOrEqual(38);
  expect(box390.height).toBeGreaterThanOrEqual(42);
  expect(box390.height).toBeLessThanOrEqual(46);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const resendLinkBox390 = await page.locator('#checkout-account-code-resend-btn').boundingBox();
  expect(resendLinkBox390.height).toBeGreaterThanOrEqual(44);
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
  await expect(page.locator('#checkout-account-code-email')).toHaveText(maskEmailForDisplay(email));
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
  await expect(page.locator('#checkout-account-code-email')).toHaveText(maskEmailForDisplay(newEmail));

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
  await expect(page.locator('#checkout-account-code-email')).toHaveText(maskEmailForDisplay(email));
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

// POINT 4: a rate-limited automatic resend (Supabase's own throttle
// tripping on THIS resend attempt, distinct from the account's actual
// original code) used to strand the customer on the password form with a
// flat "too many attempts" -- a real code almost certainly already exists
// to enter (that's exactly why the throttle just tripped), so this still
// reaches the code step instead of failing the login outright.
test('logging in with an unconfirmed email whose automatic resend is itself rate-limited still reaches the code step with a retry countdown (EN)', async ({ page }) => {
  await gotoAccount(page, 'en');
  const email = uniqueEmail('unconfirmedratelimited');
  await page.evaluate(() => { window.__mock.emailExists = true; });
  await submitEmailStep(page, email);
  await expect(page.locator('#checkout-account-login-password')).toBeVisible();

  await page.evaluate(() => {
    window.__mock.signInError = { message: 'Email not confirmed', code: 'email_not_confirmed', status: 400 };
    window.__mock.resendError = { message: 'For security purposes, you can only request this after 45 seconds.', status: 429 };
  });
  await page.fill('#checkout-account-login-password', 'whatever-does-not-matter');
  await page.click('#checkout-account-login-submit-btn');

  await expect(page.locator('#checkout-account-code')).toBeVisible();
  await expect(page.locator('#checkout-account-login-error')).toBeHidden();
  await expect(page.locator('#checkout-account-code-status')).toHaveText(
    'A code has already been sent to you. You can request a new one in 45s.'
  );
  // Reflects Supabase's own reported wait (45s), not the project's own
  // default RESEND_COOLDOWN_SECONDS (60s).
  const resendBtn = page.locator('#checkout-account-code-resend-btn');
  await expect(resendBtn).toBeDisabled();
  await expect(resendBtn).toHaveText('Resend code in 45s');
});

// Same path, but Supabase's blunter hourly quota this time (no specific
// wait given) -- falls back to RESEND_COOLDOWN_SECONDS (60s).
test('logging in with an unconfirmed email during the hourly email limit still reaches the code step with the default cooldown (FR)', async ({ page }) => {
  await gotoAccount(page, 'fr');
  const email = uniqueEmail('unconfirmedhourly');
  await page.evaluate(() => { window.__mock.emailExists = true; });
  await submitEmailStep(page, email);
  await expect(page.locator('#checkout-account-login-password')).toBeVisible();

  await page.evaluate(() => {
    window.__mock.signInError = { message: 'Email not confirmed', code: 'email_not_confirmed', status: 400 };
    window.__mock.resendError = { message: 'Email rate limit exceeded', code: 'over_email_send_rate_limit', status: 429 };
  });
  await page.fill('#checkout-account-login-password', 'whatever-does-not-matter');
  await page.click('#checkout-account-login-submit-btn');

  await expect(page.locator('#checkout-account-code')).toBeVisible();
  await expect(page.locator('#checkout-account-code-status')).toHaveText(
    'Un code vous a déjà été envoyé. Vous pourrez en demander un nouveau dans 60 s.'
  );
  const resendBtn = page.locator('#checkout-account-code-resend-btn');
  await expect(resendBtn).toBeDisabled();
  await expect(resendBtn).toHaveText('Renvoyer le code dans 60 s');
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
  await expect(page.locator('#checkout-account-code-email')).toHaveText(maskEmailForDisplay(email));
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
