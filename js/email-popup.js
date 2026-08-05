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

  // Urgency line's own count -- same "static, admin-set, never derived from
  // real data" pattern as js/promo-countdown.js's own relative-mode duration
  // (see public.site_config's own promo_codes_remaining column comment) in
  // 'fixed' mode; in 'real' mode (site_config.promo_remaining_mode) it's
  // instead computed live from whichever promo_codes row
  // site_config.promo_remaining_code_id points at (selected in admin.html's
  // Promo Codes tab, not hardcoded to PROMO_CODE/MONARK10 -- that constant
  // above is only ever the code ADVERTISED in the confirmation copy, a
  // separate, unrelated concern from which code this counter tracks; see
  // this feature's own migration comment) -- still read client-side, still
  // nothing written back, no wiring into checkout/order logic either way.
  //
  // No centralized site_config loader exists to reuse (js/promo-countdown.js's
  // own fetch is self-contained/non-exported, matching this project's
  // established "no _shared/ import between self-contained files" convention
  // -- see e.g. supabase/functions/create-checkout-session's own comment on
  // that), so this is its own minimal fetch rather than a second copy of
  // that file's own (different-column) one.
  const PROMO_CODES_REMAINING_FALLBACK = 7; // 'fixed' mode's own fallback -- matches site_config.promo_codes_remaining's own DB default, used only if the site_config lookup itself fails/hasn't resolved (mode unknown), same "never let a backend hiccup silently drop a site-wide feature" reasoning as js/promo-countdown.js's own FALLBACK_HOURS
  let promoCodesRemaining = null; // resolved by loadPromoCodesRemaining() below, well before TRIGGER_DELAY_MS elapses in the normal case
  // 'real' mode only -- true when the mode is confirmed 'real' but a usable
  // count still couldn't be computed (promo_remaining_code_id null/dangling,
  // or the pointed-at row's own max_uses null despite admin.html's own
  // save-time guard -- shouldn't normally happen, but data can change
  // between saves). Deliberately NOT treated like a lookup failure: showing
  // PROMO_CODES_REMAINING_FALLBACK here would be a fabricated number with no
  // relation to the real max_uses/times_used this mode promises, worse than
  // showing nothing.
  let promoCodesRemainingHidden = false;

  async function loadPromoCodesRemaining() {
    if (!window.MonarkSupabase) return;
    try {
      const { data: config, error: configError } = await window.MonarkSupabase
        .from('site_config')
        .select('promo_remaining_mode, promo_codes_remaining, promo_remaining_code_id')
        .limit(1)
        .maybeSingle();
      if (configError || !config) return; // mode unknown -- falls through to 'fixed'-style fallback in urgencyText()

      if (config.promo_remaining_mode === 'real') {
        if (!config.promo_remaining_code_id) {
          promoCodesRemainingHidden = true;
          return;
        }
        const { data: promo, error: promoError } = await window.MonarkSupabase
          .from('promo_codes')
          .select('max_uses, times_used')
          .eq('id', config.promo_remaining_code_id)
          .maybeSingle();
        if (promoError || !promo || promo.max_uses === null) {
          promoCodesRemainingHidden = true;
          return;
        }
        promoCodesRemaining = Math.max(0, promo.max_uses - promo.times_used);
        return;
      }

      if (Number.isFinite(config.promo_codes_remaining)) promoCodesRemaining = config.promo_codes_remaining;
    } catch (err) {
      console.error('email-popup.js: site_config/promo_codes lookup failed:', err && err.message);
    }
  }
  loadPromoCodesRemaining();

  // ---------------- Shared submission logic ----------------
  // Extracted so any other on-page email-capture form (see product.html's
  // newsletter section, which loads this file for exactly this object) goes
  // through the same validation/capture/confirmation-copy path instead of a
  // second, copy-pasted implementation -- there's only one real backend here
  // (public.newsletter_subscribers, see captureEmail() below), so there's
  // exactly one place that should know how it works.
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

  // window.MonarkValidateName / MonarkValidateCity / MonarkValidateCardName /
  // MonarkValidateAddress -- same "one canonical check, hung off window,
  // living wherever it's loaded on every page that needs it" pattern as
  // MonarkValidateEmail just above. Between them these cover every short
  // human-typed text field on the site that previously had no format
  // validation at all (or, at best, a bare non-empty check): first/last
  // name (checkout.html's Shipping form, account.html's Edit Profile form,
  // the shared account-gate's Create Account form in js/account.js), City
  // and Address (checkout.html's Shipping form, account.html's Saved
  // Address form), and Name on Card (account.html's mock Saved Card form)
  // -- so e.g. "111" or "John@Doe" no longer silently pass as a city or a
  // cardholder name anywhere. Deliberately NO minimum length on any of
  // these -- real names/cities as short as one or two characters exist
  // ("Li", "Jo", "Or" (Israel), "Y") -- so each only rejects on:
  // empty/whitespace-only, disallowed characters, or over length.
  //
  // isValidTextField() is the shared core every one of the specific
  // checks below is built from: trim, reject empty, reject over
  // maxLength, reject anything not matching the field's own allowed-
  // character pattern, and (unless explicitly turned off) require at
  // least one actual letter -- without that last part, a field containing
  // only e.g. "-" or "123" would otherwise pass a pattern that merely
  // permits digits/punctuation as PART of a value, which isn't a real
  // name/city/address on its own.
  const HAS_LETTER_RE = /\p{L}/u;
  function isValidTextField(value, options) {
    const trimmed = String(value || '').trim();
    if (!trimmed || trimmed.length > options.maxLength) return false;
    if (!options.pattern.test(trimmed)) return false;
    return options.requireLetter === false || HAS_LETTER_RE.test(trimmed);
  }

  const NAME_MAX_LENGTH = 50;
  // Unicode letters (\p{L}) + combining marks (\p{M}, for names typed with
  // decomposed accents, e.g. "e" + a combining acute rather than the single
  // precomposed "é" codepoint -- both need to keep working) + space +
  // hyphen (Jean-Pierre) + straight and curly apostrophes (O'Brien /
  // O’Brien, the latter being what iOS/most autocorrect actually inserts).
  // No digits, no other punctuation/symbols.
  const NAME_FORMAT_RE = /^[\p{L}\p{M}' ’-]+$/u;

  function isValidNameFormat(name) {
    return isValidTextField(name, { maxLength: NAME_MAX_LENGTH, pattern: NAME_FORMAT_RE });
  }
  window.MonarkValidateName = isValidNameFormat;

  // Name on Card (account.html's mock Saved Card form) -- explicitly the
  // same rule as first/last names above (it IS a person's name, just one
  // printed on a card rather than filed separately), reusing the exact
  // same length/pattern constants rather than redeclaring near-identical
  // ones under a different name.
  function isValidCardNameFormat(name) {
    return isValidTextField(name, { maxLength: NAME_MAX_LENGTH, pattern: NAME_FORMAT_RE });
  }
  window.MonarkValidateCardName = isValidCardNameFormat;

  const CITY_MAX_LENGTH = 100;
  // Same letters/marks/space/hyphen/apostrophe set as names, plus a period
  // -- unlike a person's name, a real city name commonly needs one
  // ("St. Tropez", "St-Étienne" already covered by the hyphen).
  const CITY_FORMAT_RE = /^[\p{L}\p{M}' ’.-]+$/u;

  function isValidCityFormat(city) {
    return isValidTextField(city, { maxLength: CITY_MAX_LENGTH, pattern: CITY_FORMAT_RE });
  }
  window.MonarkValidateCity = isValidCityFormat;

  const ADDRESS_MAX_LENGTH = 150;
  // Longer than a name/city since a real street address packs in more --
  // house/building number, street name, sometimes an apartment/suite
  // reference -- so digits and commas join the allowed set alongside
  // letters/marks/space/hyphen/apostrophe/period.
  const ADDRESS_FORMAT_RE = /^[\p{L}\p{M}0-9' ’.,-]+$/u;

  function isValidAddressFormat(address) {
    return isValidTextField(address, { maxLength: ADDRESS_MAX_LENGTH, pattern: ADDRESS_FORMAT_RE });
  }
  window.MonarkValidateAddress = isValidAddressFormat;

  function validateEmail(email) {
    if (!email) return { ok: false, errorKey: 'errorEmpty' };
    if (!isValidEmailFormat(email)) return { ok: false, errorKey: 'errorInvalid' };
    return { ok: true };
  }

  // Real capture -- inserts into public.newsletter_subscribers (see
  // supabase/migrations/20260801000000_add_newsletter_subscribers_table.sql),
  // an INSERT-only table from the client's own perspective (no SELECT/
  // UPDATE/DELETE policy exists, so this can't read back, correct, or remove
  // what it just wrote -- captured addresses are only ever retrievable via
  // the Supabase Dashboard/SQL Editor). `source` distinguishes this popup
  // ('popup', set by its own submit handler below) from product.html's
  // newsletter section ('newsletter_section', set by that page's own
  // handler) -- both call this exact same function.
  //
  // `honeypotValue` is whatever .email-popup-honeypot held at submit time --
  // always empty for a real visitor (it's positioned off-screen, out of the
  // tab order, and hidden from assistive tech, so nobody legitimately reaches
  // it), non-empty only when something filled in every field on the form
  // without rendering CSS, i.e. a bot. Checked first, before even the
  // Supabase-loaded check below, so a bot gets the exact same silent
  // no-op/success path regardless of anything else about the page state --
  // never tipped off that it was caught.
  //
  // DISMISS_KEY is set synchronously, before the network call, same timing
  // as the old localStorage-only version -- the "don't show this popup
  // again" behavior doesn't need to wait on (or depend on the outcome of)
  // the actual insert succeeding.
  //
  // Callers don't await this (matching how the old synchronous version was
  // always called) -- the confirmation UI renders immediately either way,
  // same as before real persistence existed; this resolves in the
  // background rather than making the user wait on a network round trip for
  // what's already a purely cosmetic "thanks!" message.
  async function captureEmail(email, source, honeypotValue) {
    localStorage.setItem(DISMISS_KEY, 'true');
    if (honeypotValue) return; // bot -- pretend success, never touch Supabase
    if (!window.MonarkSupabase) return; // graceful no-op if the client script failed to load -- never blocks the UI over this
    const language = window.MonarkI18n ? window.MonarkI18n.getLang() : 'fr';
    const { error } = await window.MonarkSupabase.from('newsletter_subscribers').insert({ email, source, language });
    if (error && error.code !== '23505') {
      // 23505 = unique_violation (already subscribed with this email) --
      // not a real failure from the user's own perspective, so it's not
      // logged as one; no UPDATE policy exists to instead refresh
      // subscribed_at for a resubscribe (this table is INSERT-only by
      // design, see the migration's own comment), so silently treating it
      // as a normal successful subscribe is the graceful option that
      // migration explicitly leaves this to. Any OTHER error (network down,
      // RLS/grant misconfigured, etc.) is logged for debugging only -- this
      // is a best-effort marketing signup, not a transaction, and the UI
      // never had a failure state for this before real persistence existed;
      // inventing one now would be a worse experience than just not
      // receiving the address this one time.
      console.error('MonarkEmailCapture.captureEmail:', error.message);
    }
  }

  // Returns null when the line should be hidden entirely (confirmed 'real'
  // mode, no computable count -- see promoCodesRemainingHidden's own
  // comment); otherwise falls back to PROMO_CODES_REMAINING_FALLBACK if the
  // site_config lookup itself hasn't resolved yet or failed outright (mode
  // unknown). This is shown-once-per-popup, not live-updating, so there's no
  // "changed mid-view" case to handle beyond a language switch (see
  // renderUrgency() at this function's own call site).
  function urgencyText() {
    if (promoCodesRemainingHidden) return null;
    const count = promoCodesRemaining !== null ? promoCodesRemaining : PROMO_CODES_REMAINING_FALLBACK;
    return window.MonarkI18n
      ? window.MonarkI18n.t('emailPopup.promoCodesRemaining', { count })
      : `Only ${count} promo codes left at this price.`;
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
          <p class="email-popup-urgency"></p>
          <form class="email-popup-form" novalidate>
            <input type="email" class="email-popup-input" placeholder="you@email.com" required aria-label="Email address" data-i18n-attr="placeholder:emailPopup.emailPlaceholder;aria-label:emailPopup.emailAriaLabel">
            <input type="text" class="email-popup-honeypot" name="hp_email_confirm" tabindex="-1" autocomplete="off" aria-hidden="true">
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

    // Dynamic (fetched) count, so this can't be a plain data-i18n tag (see
    // urgencyText()'s own comment) -- rendered manually here instead, same
    // as confirmedTexts()/renderConfirmed() below does for its own dynamic
    // values, and re-rendered on every language switch for the same reason.
    // Naturally stops mattering once renderConfirmed() replaces
    // .email-popup-body's entire innerHTML on submit (the confirmed state
    // has no urgency line of its own -- reminding someone who just claimed a
    // code how many are "left" doesn't make sense) -- this listener is left
    // running but just writes into a detached, no-longer-visible node at
    // that point, cleaned up like any other listener in dismiss() below.
    const urgencyEl = overlay.querySelector('.email-popup-urgency');
    // null (see urgencyText()'s own comment) hides the line entirely --
    // 'real' mode with no computable count -- rather than showing a
    // fabricated value; .hidden works fine here, .email-popup-urgency has
    // no conflicting `display` rule to fight (see css/style.css).
    function renderUrgency() {
      const text = urgencyText();
      urgencyEl.hidden = text === null;
      if (text !== null) urgencyEl.textContent = text;
    }
    renderUrgency();
    document.addEventListener('monark:langchange', renderUrgency);

    function dismiss() {
      localStorage.setItem(DISMISS_KEY, 'true');
      overlay.classList.remove('email-popup-visible');
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('monark:langchange', renderUrgency);
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

    // SECURITY (placeholder, once a real ESP integration exists): the
    // honeypot field just below catches simple bots that blindly fill in
    // every field on a form, but a targeted bot that actually parses the
    // markup (sees .email-popup-honeypot is off-screen and skips it) isn't
    // stopped by this alone -- still worth rate-limiting submissions per IP/
    // session server-side (e.g. via an Edge Function in front of the insert,
    // same shape as supabase/functions/validate-promo-code) before this
    // table's row count is something anyone relies on being clean. See
    // README.md's "Forms" section.
    overlay.querySelector('.email-popup-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = overlay.querySelector('.email-popup-input');
      const honeypot = overlay.querySelector('.email-popup-honeypot');
      const errorEl = overlay.querySelector('.email-popup-error');
      const email = input.value.trim();
      const result = validateEmail(email);
      if (!result.ok) {
        errorEl.textContent = window.MonarkI18n ? window.MonarkI18n.t('emailPopup.' + result.errorKey) : 'Please enter a valid email address.';
        errorEl.hidden = false;
        return;
      }
      errorEl.hidden = true;
      captureEmail(email, 'popup', honeypot.value);

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
