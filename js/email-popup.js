/* MONARK — site-wide "10% off" email capture popup. Shared across every page;
   include via <script src="js/email-popup.js"></script> (after cookie-consent.js).

   Trigger: a flat 6s delay after page load, not exit-intent -- exit-intent has
   no real equivalent on touch devices (a large share of traffic), and a flat
   delay keeps behavior identical everywhere instead of shipping two paths.

   Dismissal (via the × button, clicking outside, Escape, or a completed
   submission) is remembered in localStorage so it only ever shows once per
   visitor, same pattern as js/cookie-consent.js's own dismissal flag -- just a
   separate key, since accepting/rejecting cookies has nothing to do with
   having already seen this offer. */
(function () {
  const DISMISS_KEY = 'monark_email_popup_dismissed';
  // Placeholder for a real email-marketing integration (Klaviyo/Mailchimp/etc.)
  // -- no backend or ESP is wired up yet, so "capturing" an email just means
  // appending it to this localStorage array for now.
  const CAPTURED_KEY = 'monark_captured_emails';
  const TRIGGER_DELAY_MS = 6000;
  const COOKIE_BANNER_POLL_MS = 300;
  // The code shown here must be an active row in the public.promo_codes
  // table (see supabase/functions/validate-promo-code) -- js/cart.js no
  // longer ships a client-side map of valid codes to read this from (that's
  // the whole point: the discount rate and which strings are valid codes at
  // all now live server-side only), so this is hardcoded as plain marketing
  // copy instead. Advertising the code itself is expected/intentional; it's
  // only the discount VALUE and validation logic that had to move server-side.
  const PROMO_CODE = 'MONARK10';

  // ---------------- Shared submission logic ----------------
  // Extracted so any other on-page email-capture form (see product.html's
  // newsletter section, which loads this file for exactly this object) goes
  // through the same validation/capture/confirmation-copy path instead of a
  // second, copy-pasted implementation -- there's only one real "backend"
  // here (the mocked localStorage capture below, see CAPTURED_KEY's own
  // comment), so there's exactly one place that should know how it works.
  //
  // window.MonarkValidateEmail (below) is ALSO the single canonical email
  // format check for the rest of the site -- js/account.js's own
  // isPlausibleEmail (used by the shared account-gate widget on both
  // account.html and checkout.html), account.html's Edit Profile email
  // field, and contact.html's form all call it instead of keeping their own
  // separate regex, so a real address is never accepted in one place and
  // rejected in another (previously each had a near-identical but
  // independently-maintained copy of a much looser check -- see this
  // function's own git history). This file is loaded on every page that has
  // an email field (index.html, product.html, account.html, checkout.html,
  // contact.html), so it's the natural home for it.
  //
  // Deliberately NOT a full RFC 5322 validator -- that grammar technically
  // allows quoted local-parts, IP-literal domains, etc. that essentially no
  // real signup form accepts in practice either. This is a solid, realistic
  // FORMAT check only: proper local@domain shape, a real-looking multi-
  // character alphabetic TLD, sane length limits, no leading/trailing/
  // consecutive dots. It deliberately does NOT attempt deliverability
  // verification (MX record lookup, disposable-domain blocklist, etc.) --
  // this is a static site with no backend to run that kind of check from;
  // doing it for real would need a server-side service.
  const EMAIL_MAX_LENGTH = 254; // RFC 5321 total envelope length ceiling
  const EMAIL_LOCAL_PART_MAX_LENGTH = 64; // RFC 5321 local-part length ceiling
  // local-part: the common unquoted atext charset (letters/digits and
  // !#$%&'*+/=?^_`{|}~- , dots included but validated separately below,
  // since a charset alone can't forbid a dot from leading/trailing/
  // repeating). Plus-addressing ("user+tag@domain.com") is a bare "+" in
  // this charset, so it's already covered, no special-casing needed.
  // domain: one or more "label." groups followed by a final all-letters TLD
  // of 2+ characters -- each label starts and ends with a letter/digit (an
  // internal hyphen is fine, a leading/trailing one isn't, matching real DNS
  // label rules), which also structurally rules out "user@domain" (no dot
  // at all -- the "+" requires at least one "label." before the TLD) and
  // "u@u.u" (single-letter TLD, fails the {2,}).
  const EMAIL_FORMAT_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

  function isValidEmailFormat(email) {
    if (!email || email.length > EMAIL_MAX_LENGTH) return false;
    const atIndex = email.lastIndexOf('@');
    if (atIndex === -1) return false;
    const localPart = email.slice(0, atIndex);
    if (!localPart || localPart.length > EMAIL_LOCAL_PART_MAX_LENGTH) return false;
    if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) return false;
    return EMAIL_FORMAT_RE.test(email);
  }
  window.MonarkValidateEmail = isValidEmailFormat;

  function validateEmail(email) {
    if (!email) return { ok: false, errorKey: 'errorEmpty' };
    if (!isValidEmailFormat(email)) return { ok: false, errorKey: 'errorInvalid' };
    return { ok: true };
  }

  // Mocked capture only -- no email is actually sent, there's no ESP wired
  // up yet (see CAPTURED_KEY's own comment above). Also sets DISMISS_KEY:
  // whichever form on the page captured this address, the visitor has
  // already given it and claimed their code, so the popup itself shouldn't
  // still nag them for it later this session or on a future page load.
  function captureEmail(email) {
    let captured = [];
    try { captured = JSON.parse(localStorage.getItem(CAPTURED_KEY)) || []; } catch (err) { captured = []; }
    captured.push({ email, promoCode: PROMO_CODE, capturedAt: new Date().toISOString() });
    localStorage.setItem(CAPTURED_KEY, JSON.stringify(captured));
    localStorage.setItem(DISMISS_KEY, 'true');
  }

  // Returns the post-submit confirmation copy, kicker/heading/newsletter note
  // as plain text and the body copy as HTML with the email address left as an
  // EMPTY .email-popup-confirmed-email placeholder span -- callers insert the
  // typed address themselves via .textContent (never interpolated into the
  // HTML string) so a value like "<img onerror=...>" typed into the field
  // can't execute; the {code} promo code is safe to interpolate directly,
  // it's our own PROMO_CODE constant, never user input.
  function confirmedTexts() {
    const kicker = window.MonarkI18n ? window.MonarkI18n.t('emailPopup.confirmedKicker') : 'Confirmed';
    const heading = window.MonarkI18n ? window.MonarkI18n.t('emailPopup.confirmedHeading', { code: PROMO_CODE }) : `Your Code: ${PROMO_CODE}`;
    const EMAIL_TOKEN = '@@EMAIL@@';
    const copyTemplate = window.MonarkI18n
      ? window.MonarkI18n.t('emailPopup.confirmedCopy', { email: EMAIL_TOKEN })
      : `10% off your first bottle, enter it at checkout. Sent to ${EMAIL_TOKEN} too, for safekeeping.`;
    const copyHtml = copyTemplate.replace(EMAIL_TOKEN, '<span class="email-popup-confirmed-email"></span>');
    const newsletterNote = window.MonarkI18n
      ? window.MonarkI18n.t('emailPopup.newsletterDisclosure')
      : "You've also been subscribed to our newsletter.";
    return { kicker, heading, copyHtml, newsletterNote };
  }

  window.MonarkEmailCapture = { PROMO_CODE, validateEmail, captureEmail, confirmedTexts };

  if (localStorage.getItem(DISMISS_KEY)) return;

  // The cookie banner (js/cookie-consent.js) appears instantly, bottom-fixed,
  // and stays until the user acts on it -- if this popup's own delay elapses
  // while that's still up, wait for it to clear first rather than showing both
  // at once (a centered modal + dimmed backdrop stacked on top of the banner
  // reads as a collision, not two separate, deliberate prompts).
  function cookieBannerStillUp() {
    return !localStorage.getItem('monark_cookie_consent') && !!document.getElementById('cookie-banner');
  }

  function waitThenShow() {
    if (cookieBannerStillUp()) {
      setTimeout(waitThenShow, COOKIE_BANNER_POLL_MS);
      return;
    }
    showPopup();
  }

  setTimeout(waitThenShow, TRIGGER_DELAY_MS);

  function showPopup() {
    if (localStorage.getItem(DISMISS_KEY)) return; // e.g. dismissed in another tab while waiting

    const opener = document.activeElement; // restored on dismiss, whatever it was (this popup is timer-triggered, not a click)
    // Set only once the confirmation state renders (see renderConfirmed() below)
    // -- lets dismiss() clean it up so a page that never even reaches that
    // state never carries the listener at all.
    let confirmedLangListener = null;

    const overlay = document.createElement('div');
    overlay.className = 'email-popup-overlay';
    overlay.id = 'email-popup-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Email signup offer');
    overlay.setAttribute('data-i18n-attr', 'aria-label:emailPopup.ariaLabel');
    overlay.innerHTML = `
      <div class="email-popup">
        <button type="button" class="email-popup-close" aria-label="Close" data-i18n-attr="aria-label:emailPopup.close">&times;</button>
        <div class="email-popup-body" aria-live="polite">
          <span class="section-label email-popup-kicker" data-i18n="emailPopup.kicker">A Small Concession</span>
          <h2 class="email-popup-heading" data-i18n="emailPopup.heading">Get 10% Off Your First Bottle</h2>
          <p class="email-popup-copy" data-i18n="emailPopup.copy">Join the list before we run out of bottles.</p>
          <form class="email-popup-form" novalidate>
            <input type="email" class="email-popup-input" placeholder="you@email.com" required aria-label="Email address" data-i18n-attr="placeholder:emailPopup.emailPlaceholder;aria-label:emailPopup.emailAriaLabel">
            <p class="email-popup-consent" data-i18n="emailPopup.consent">By submitting, you agree to receive marketing emails from Effluve Paris.</p>
            <p class="promo-message promo-message-error email-popup-error" aria-live="polite" hidden></p>
            <button type="submit" class="cta-button email-popup-submit" data-i18n="emailPopup.submit">Claim My 10%</button>
          </form>
        </div>
      </div>
    `;
    if (window.MonarkI18n) window.MonarkI18n.apply(overlay);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('email-popup-visible'));
    overlay.querySelector('.email-popup-input').focus();

    function dismiss() {
      localStorage.setItem(DISMISS_KEY, 'true');
      overlay.classList.remove('email-popup-visible');
      document.removeEventListener('keydown', onKeydown);
      if (confirmedLangListener) document.removeEventListener('monark:langchange', confirmedLangListener);
      setTimeout(() => overlay.remove(), 300);
      // Only steal focus back if it's still sitting somewhere inside the popup
      // (the user could have already tabbed/clicked elsewhere on the page).
      if (opener && typeof opener.focus === 'function' && overlay.contains(document.activeElement)) {
        opener.focus();
      }
    }

    // Keeps Tab/Shift+Tab cycling within the popup instead of leaking out to
    // the page behind it -- re-queries focusable elements on every press
    // rather than caching them once, since the submit handler below swaps in
    // an entirely different (focusable-button-only) confirmation state.
    function trapTab(e) {
      if (e.key !== 'Tab') return;
      const focusable = Array.from(overlay.querySelectorAll('button, input, a[href]'))
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    function onKeydown(e) {
      if (e.key === 'Escape') dismiss();
      trapTab(e);
    }

    overlay.querySelector('.email-popup-close').addEventListener('click', dismiss);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
    document.addEventListener('keydown', onKeydown);

    // SECURITY (placeholder, once a real ESP/backend exists): nothing guards
    // this against bot submissions today because there's no real endpoint yet
    // to spam. Before wiring one up, add a honeypot field (hidden input real
    // users never fill in; silently drop the submission if it's non-empty)
    // and rate-limit submissions per IP/session server-side. See README.md's
    // "Forms" section.
    overlay.querySelector('.email-popup-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = overlay.querySelector('.email-popup-input');
      const errorEl = overlay.querySelector('.email-popup-error');
      const email = input.value.trim();
      const result = validateEmail(email);
      if (!result.ok) {
        errorEl.textContent = window.MonarkI18n ? window.MonarkI18n.t('emailPopup.' + result.errorKey) : 'Please enter a valid email address.';
        errorEl.hidden = false;
        return;
      }
      errorEl.hidden = true;
      captureEmail(email);

      // renderConfirmed (not a one-off template) so a language switch while
      // this state is still showing (via the nav menu's FR/EN toggle) can
      // redraw it -- the promo code/email vars mean this can't just be plain
      // data-i18n tags re-walked by MonarkI18n.apply() like the rest of the
      // popup.
      function renderConfirmed() {
        const { kicker, heading, copyHtml, newsletterNote } = confirmedTexts();
        // Separate line, separate key from copyHtml -- this is the
        // newsletter subscription disclosure specifically, distinct from
        // js/account.js's own "confirmation email sent" note for account
        // creation (that one only ever shows on the account gate, never here).
        // Reuses .email-popup-consent's small-mono-muted fine-print treatment
        // (already used for the form state's "you agree to receive..." line)
        // rather than inventing a second disclosure-text style.
        overlay.querySelector('.email-popup-body').innerHTML = `
          <span class="section-label email-popup-kicker">${kicker}</span>
          <h2 class="email-popup-heading">${heading}</h2>
          <p class="email-popup-copy">${copyHtml}</p>
          <p class="email-popup-consent">${newsletterNote}</p>
        `;
        overlay.querySelector('.email-popup-confirmed-email').textContent = email;
      }
      renderConfirmed();
      confirmedLangListener = renderConfirmed;
      document.addEventListener('monark:langchange', confirmedLangListener);
      // The form (including whatever had focus) was just replaced -- move focus
      // to the one remaining focusable control so it isn't silently dropped to <body>.
      // No auto-dismiss timer here (there used to be one) -- confirmed via real
      // mobile testing that it closed the confirmation before the code was even
      // readable. The × button (a sibling of .email-popup-body, so untouched by
      // the innerHTML swap above -- still present and wired to dismiss()),
      // outside-click, and Escape are all still available; the user just
      // decides when they're done reading it.
      overlay.querySelector('.email-popup-close').focus();
    });
  }
})();
