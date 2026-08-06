(function () {
  const shippingForm = document.getElementById('checkout-form');
  function t(key, vars) { return window.MonarkI18n ? window.MonarkI18n.t(key, vars) : key; }

  // Landed here right after a successful Payment Request Button purchase on
  // product.html (Apple Pay/Google Pay/Link) -- payment was already
  // confirmed and the order already recorded there (see product.html's own
  // 'paymentmethod' handler); this just shows the same confirmation state a
  // normal checkout submission ends on, using the total passed via the URL
  // (the cart that total came from has already been cleared by the time
  // this page loads, so there's nothing left to derive it from here).
  // Short-circuits everything below -- the interactive accordion/Stripe
  // Elements/promo forms have nothing to do on a page that's already done.
  const expressParams = new URLSearchParams(window.location.search);
  if (expressParams.get('expressSuccess') === '1') {
    const expressTotal = parseFloat(expressParams.get('total'));
    document.getElementById('checkout-form-state').hidden = true;
    document.getElementById('checkout-confirmation').hidden = false;
    const titleEl = document.getElementById('checkout-title');
    titleEl.removeAttribute('data-i18n');
    titleEl.textContent = t('checkout.thankYou');
    document.getElementById('checkout-confirmation-total').textContent = t('checkout.confirmationTotal', {
      total: money(isNaN(expressTotal) ? 0 : expressTotal)
    });
    window.scrollTo(0, 0);
    return;
  }

  /* ---------------- Accordion state machine ----------------
     Three sections (account/shipping/payment), only one ever "active"
     (expanded) at a time. A section that's been successfully validated once
     collapses to 'completed' (compact summary line in its own header,
     clickable to re-open); a section not yet reached stays 'pending'
     (collapsed, header disabled -- can't jump ahead of the flow). Payment
     never itself becomes 'completed' -- it's the last step, and a successful
     submit replaces the whole accordion with the confirmation view instead
     of collapsing back down. */
  const STEP_ORDER = ['account', 'shipping', 'payment'];
  const sectionEls = {};
  STEP_ORDER.forEach((step) => {
    sectionEls[step] = {
      root: document.getElementById('checkout-section-' + step),
      header: document.getElementById('checkout-' + step + '-header'),
      body: document.getElementById('checkout-' + step + '-body'),
      summary: document.getElementById('checkout-' + step + '-header-summary')
    };
  });
  const sectionState = { account: 'active', shipping: 'pending', payment: 'pending' };
  const completedFlags = { account: false, shipping: false, payment: false };

  function applyAccordionState() {
    STEP_ORDER.forEach((step) => {
      const { root, header, body } = sectionEls[step];
      const state = sectionState[step];
      body.hidden = state !== 'active';
      header.setAttribute('aria-expanded', String(state === 'active'));
      header.disabled = state === 'pending';
      root.classList.toggle('checkout-accordion-active', state === 'active');
      root.classList.toggle('checkout-accordion-completed', state === 'completed');
    });
  }

  // Opens `step`, collapsing whichever section was open -- back to
  // 'completed' if it already has a valid summary on file, or 'pending'
  // (locked again) if it doesn't (e.g. reopening Shipping while Payment was
  // active but never actually submitted).
  function openAccordionSection(step) {
    STEP_ORDER.forEach((s) => {
      if (s === step) {
        sectionState[s] = 'active';
      } else if (sectionState[s] === 'active') {
        sectionState[s] = completedFlags[s] ? 'completed' : 'pending';
      }
    });
    applyAccordionState();
  }

  function completeAccordionSection(step, summaryText) {
    completedFlags[step] = true;
    sectionEls[step].summary.textContent = summaryText;
  }

  // Clicking a header only ever re-opens an already-completed (collapsed)
  // section -- pending headers are disabled outright, and clicking the
  // currently-active section's own header is a harmless no-op (nothing to
  // collapse it into).
  STEP_ORDER.forEach((step) => {
    sectionEls[step].header.addEventListener('click', () => {
      if (sectionState[step] === 'completed') openAccordionSection(step);
    });
  });

  // Mobile-only Paiement recap -- a plain, freely-toggleable panel, not part
  // of the STEP_ORDER machine above (no gating, no "completed" state, opens
  // and closes on every click regardless of where the user is in
  // Account/Shipping/Billing).
  const mobileSummaryHeader = document.getElementById('checkout-mobile-summary-header');
  const mobileSummaryBody = document.getElementById('checkout-mobile-summary-body');
  mobileSummaryHeader.addEventListener('click', () => {
    const willOpen = mobileSummaryBody.hidden;
    mobileSummaryBody.hidden = !willOpen;
    mobileSummaryHeader.setAttribute('aria-expanded', String(willOpen));
  });

  // See js/account.js's mountAccountGate() -- same email/log-in/create-
  // account flow account.html uses, extracted there so this page and that
  // one share one implementation instead of two that can drift apart.
  // statusLabel/changeLabel are passed as functions (not plain strings) so
  // mountAccountGate() can re-invoke them fresh on every 'monark:langchange'
  // -- see that file's own comment on why a plain string captured once at
  // mount time can't respond to a later language switch.
  // Replaces the old plain <input name="phone">, same "shared, not
  // duplicated" component as the account gate's own create-account phone
  // field (see js/phone-input.js) -- defaults to France/+33 for a fresh,
  // empty field, same as that one.
  const shippingPhoneError = document.getElementById('checkout-error-phone');
  // onChange live-clears a shown error as the user edits -- same convention
  // shippingFields' own `input` listeners already use below for every other
  // field on this form (see updateShippingNextBtnState()'s own comment).
  const shippingPhoneWidget = window.MonarkPhoneInput
    ? window.MonarkPhoneInput.mount(document.getElementById('checkout-shipping-phone'), {
      onChange: () => { shippingPhoneError.hidden = true; }
    })
    : null;

  // Pre-fills First/Last Name + Address/Address Line 2/City/Postal Code/Phone
  // from the account's own saved profile/address (js/account.js's
  // updateAccount()) whenever a logged-in (non-guest) session resolves --
  // guests have no account record to read from, so this is a no-op for them,
  // same as it always was. Only fills fields the account actually has a
  // value for, and only once (right when the gate resolves, before the
  // user's typed anything), so it can never clobber something the user is
  // mid-typing. No longer pre-fills Name on Card/Card Number/Expiry -- those
  // fields don't exist here anymore, replaced by the real Stripe Payment
  // Element (see checkout-stripe-payment-element below), which never accepts
  // a pre-filled/scripted card number.
  async function prefillShippingFromAccount(session) {
    if (session.isGuest) return;
    const account = await window.MonarkAccount.findAccount(session.email);
    if (!account) return;
    const fieldMap = {
      firstName: account.firstName,
      lastName: account.lastName,
      address: account.address,
      // Key doubles as the DOM `name` attribute looked up just below --
      // matches the Address Line 2 field's own renamed name="extraDetails"
      // (see that field's own comment on why), and the renamed
      // account.extraDetails model property (see js/account.js).
      extraDetails: account.extraDetails,
      city: account.city,
      postal: account.postal,
      // account.country is really the phone widget's own dial-code country
      // (js/phone-input.js's full country list, see its setValue() call just
      // below) -- not validated against France/Belgium. Only ever used here
      // to pre-select Belgium specifically; anything else (including France,
      // blank, or some unrelated country from a saved phone number) leaves
      // the <select> on its default France, since setting it to a value with
      // no matching <option> would otherwise leave the field showing no
      // selection at all.
      country: account.country === 'BE' ? 'BE' : undefined
    };
    Object.keys(fieldMap).forEach((name) => {
      const value = fieldMap[name];
      const input = shippingForm.querySelector(`[name="${name}"]`);
      if (input && value) input.value = value;
    });
    if (shippingPhoneWidget && account.phone) {
      shippingPhoneWidget.setValue({ number: account.phone, country: account.country || 'FR' });
    }
  }

  // Account section's own "Next Step" is whatever action resolves the gate
  // (guest continue / log in / create account) -- adapting that existing
  // behavior into the accordion pattern rather than replacing it with a
  // second, redundant button.
  function accountSummaryText(session) {
    return session.isGuest
      ? t('checkout.accordionAccountSummaryGuest', { email: session.email })
      : session.email;
  }

  // Abandoned-cart tracking (see public.abandoned_checkouts' own migration
  // for the full picture) -- this is the ONLY point in this codebase that
  // ever captures "a customer entered their email at the checkout Account
  // step," so it's where that half of the reminder system's data model has
  // to start. Fire-and-forget: never awaited, and a failure here (RPC
  // unreachable, etc.) is only ever logged -- this is a background
  // bookkeeping write, not something that should ever delay or block the
  // Account -> Shipping transition it's called right after.
  function trackAbandonedCheckout(session) {
    if (!session || !session.email) return;
    window.MonarkSupabase.rpc('track_abandoned_checkout', {
      p_email: session.email,
      p_language: stripeLocale(),
      p_user_id: (!session.isGuest && window.MonarkAccount.getCurrentUserId) ? window.MonarkAccount.getCurrentUserId() : null
    }).then(({ error }) => {
      if (error) console.error('trackAbandonedCheckout:', error.message);
    });
  }

  window.MonarkAccount.mountAccountGate(document.getElementById('checkout-account-gate'), {
    statusLabel: (session) => session.isGuest
      ? t('checkout.statusGuest', { email: session.email })
      : t('accountGate.loggedInAs', { email: session.email }),
    changeLabel: () => t('accountGate.modify'),
    onResolved: async (session, { identityChanged } = {}) => {
      // identityChanged is only true after a completed Modify/Modify-Email
      // edit (see js/account.js's mountAccountGate() for exactly when) lands
      // on a genuinely different email/guest-status -- Shipping/Payment's
      // own "completed" state was prefilled/validated for whoever was signed
      // in BEFORE that edit, so it needs to be won back for the new account
      // rather than keep showing stale data/status. Payment's sectionState
      // needs resetting explicitly (openAccordionSection('shipping') below
      // only demotes a section that's currently 'active', not one already
      // 'completed'). Not reset unconditionally: Cancel resolves the exact
      // same session it started with (identityChanged false), and that needs
      // to leave Shipping/Payment's progress alone entirely.
      if (identityChanged) {
        completedFlags.shipping = false;
        completedFlags.payment = false;
        sectionState.payment = 'pending';
      }
      await prefillShippingFromAccount(session);
      completeAccordionSection('account', accountSummaryText(session));
      openAccordionSection('shipping');
      trackAbandonedCheckout(session);
    },
    onUnresolved: () => {
      completedFlags.account = false;
      completedFlags.shipping = false;
      completedFlags.payment = false;
      sectionState.account = 'active';
      sectionState.shipping = 'pending';
      sectionState.payment = 'pending';
      applyAccordionState();
    }
  });

  const cart = window.MonarkCart;
  // Flipped true by the js/promo-countdown.js subscribe() below, once
  // resolved, if admin.html's Timer tab has a fixed_end_date that's already
  // passed -- summaryLinesHtml() reads this to drop the countdown note
  // entirely rather than showing a stuck value (see this file's own
  // subscribe() call site for why a re-render is triggered right when this
  // flips).
  let checkoutCountdownHidden = false;
  const summaryEl = document.getElementById('checkout-summary');
  const form = document.getElementById('checkout-form');
  const submitBtn = document.getElementById('checkout-submit-btn');
  const formState = document.getElementById('checkout-form-state');
  const confirmation = document.getElementById('checkout-confirmation');
  const confirmationTotal = document.getElementById('checkout-confirmation-total');
  const confirmationReference = document.getElementById('checkout-confirmation-reference');
  const title = document.getElementById('checkout-title');

  const promoForm = document.getElementById('checkout-promo-form');
  const promoInput = document.getElementById('checkout-promo-input');
  const promoMessage = document.getElementById('checkout-promo-message');

  // Mobile-only Paiement section's own cart/totals containers + its own
  // promo form (separate DOM/ids from the desktop column's, see the HTML
  // comment there) -- and the Billing section's recap container plus its
  // OWN mobile-only fallback promo control (a <div>, not a <form> -- see
  // that markup's own comment on why, and wireBillingPromoTrigger() below).
  const mobileCartEl = document.getElementById('checkout-mobile-cart');
  const mobileTotalsEl = document.getElementById('checkout-mobile-totals');
  const mobilePromoForm = document.getElementById('checkout-mobile-promo-form');
  const mobilePromoInput = document.getElementById('checkout-mobile-promo-input');
  const mobilePromoMessage = document.getElementById('checkout-mobile-promo-message');
  const billingRecapEl = document.getElementById('checkout-billing-recap');
  const billingPromoBox = document.getElementById('checkout-billing-promo-box');
  const billingPromoInput = document.getElementById('checkout-billing-promo-input');
  const billingPromoMessage = document.getElementById('checkout-billing-promo-message');
  const billingPromoApplyBtn = document.getElementById('checkout-billing-promo-apply-btn');

  // Custom validation for the four required shipping fields, shown with the
  // same .promo-message-error visual language as everywhere else on this
  // page -- native `required` alone falls back to the browser's own tooltip
  // styling, which doesn't match the site's design and looks different in
  // every browser. `novalidate` on the form (see the HTML) suppresses that
  // default so this is the only validation UI shown.
  // No per-field `message` here anymore -- each error <p> already carries its
  // own data-i18n tag in the HTML (checkout.errorFirstName/errorLastName/
  // errorAddress/errorCity/errorPostal), so MonarkI18n keeps its text correct
  // on its own, including across a language switch. This just toggles visibility.
  const shippingFields = [
    { input: form.querySelector('[name="firstName"]'), error: document.getElementById('checkout-error-firstName') },
    { input: form.querySelector('[name="lastName"]'), error: document.getElementById('checkout-error-lastName') },
    { input: form.querySelector('[name="address"]'), error: document.getElementById('checkout-error-address') },
    { input: form.querySelector('[name="city"]'), error: document.getElementById('checkout-error-city') },
    { input: form.querySelector('[name="postal"]'), error: document.getElementById('checkout-error-postal') }
  ];

  // Clears a field's error as soon as the user acts on it, rather than
  // leaving a stale "Please enter..." message sitting there after they've
  // already fixed it -- the next full validateShippingForm() re-checks
  // everything anyway, this just keeps the UI from lying in the meantime.
  // Also keeps the Next Step button's enabled state live as the user types,
  // per this section's own "shows a Next Step button once its required
  // fields are validly filled" spec -- the button stays visible throughout
  // (not hidden outright), just disabled until every required field has
  // something in it, so it's always discoverable rather than appearing out
  // of nowhere.
  const shippingNextBtn = document.getElementById('checkout-shipping-next-btn');
  function updateShippingNextBtnState() {
    shippingNextBtn.disabled = !shippingFields.every(({ input }) => input.value.trim());
  }
  shippingFields.forEach(({ input, error }) => {
    input.addEventListener('input', () => { error.hidden = true; updateShippingNextBtnState(); });
  });

  // Only France and Belgium are actually shippable/supported (both with free
  // shipping, see SHIPPING_FEE's own waiver further below) -- the <select> in
  // the HTML already restricts a customer to just these two values, but this
  // is re-checked here too (defense in depth against the value being changed
  // some other way) and is also what branches the postal-code format check
  // just below, since France uses 5-digit codes and Belgium uses 4.
  const ALLOWED_SHIPPING_COUNTRIES = ['FR', 'BE'];
  const countryInput = form.querySelector('[name="country"]');
  const countryError = document.getElementById('checkout-error-country');
  const postalInput = form.querySelector('[name="postal"]');
  const postalError = document.getElementById('checkout-error-postal');
  const addressInput = form.querySelector('[name="address"]');
  const addressError = document.getElementById('checkout-error-address');
  const addressSelectNudge = document.getElementById('checkout-address-select-nudge');
  // True once the "click here" link inside addressSelectNudge has been used
  // -- the whole point of that escape hatch is a real address Google Places
  // just doesn't have, so re-showing the same nudge on every later Next Step
  // click for the rest of this visit would defeat it. Page-lifetime only
  // (a plain variable, not localStorage) -- "same visit," per spec, not
  // "remembered forever"; a fresh page load starts clean like every other
  // in-memory form state on this page.
  let addressManualOverride = false;
  addressSelectNudge.addEventListener('click', (e) => {
    if (!e.target.closest('.checkout-address-manual-link')) return;
    addressManualOverride = true;
    addressSelectNudge.hidden = true;
  });
  // Retyping the address invalidates any prior selection (see
  // js/places-autocomplete.js's own 'input' listener clearing
  // placesSelected) -- hide a stale nudge from a previous submit attempt
  // rather than leaving it displayed against text that's since changed;
  // validateShippingForm() below decides fresh whether to show it again.
  addressInput.addEventListener('input', () => { addressSelectNudge.hidden = true; });
  countryInput.addEventListener('change', () => {
    countryError.hidden = true;
    // Previously-entered postal code may no longer match the new country's
    // digit count (e.g. a 5-digit FR code left in place after switching to
    // BE) -- re-validated on the next Next Step click like everything else,
    // this just clears the now-stale error rather than leaving it displayed
    // against the old country.
    postalError.hidden = true;
  });

  // Real-device bug: manually select Belgium, then trigger Chrome's saved-
  // address autofill (e.g. picking a saved FRENCH address) -- every other
  // field gets correctly overwritten, but Country silently stays on
  // "Belgique". Chrome's autofill never overwrites a field the user already
  // manually changed, so it just skips this <select> entirely -- no
  // input/change event fires on it for anything to react to; the
  // :-webkit-autofill-driven 'animationstart' below (see the matching
  // @keyframes in css/checkout.css) is what catches it instead, reading the
  // digit count of whatever autofill just put in Postal (5 = France, 4 =
  // Belgium, the only two this form supports) and correcting Country to
  // match. Dispatches a real 'change' so the listener just above (and
  // validateShippingForm()'s always-fresh countryInput.value read) both stay
  // in sync -- purely additive: manual selection through the dropdown never
  // triggers :-webkit-autofill, so this never fires for it.
  postalInput.addEventListener('animationstart', (e) => {
    if (e.animationName !== 'checkout-postal-autofill') return;
    const digits = postalInput.value.trim();
    let matchedCountry = null;
    if (/^\d{5}$/.test(digits)) matchedCountry = 'FR';
    else if (/^\d{4}$/.test(digits)) matchedCountry = 'BE';
    if (matchedCountry && countryInput.value !== matchedCountry) {
      countryInput.value = matchedCountry;
      countryInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  function validateShippingForm() {
    let firstInvalid = null;
    shippingFields.forEach(({ input, error }) => {
      if (!input.value.trim()) {
        error.hidden = false;
        if (!firstInvalid) firstInvalid = input;
      } else {
        error.hidden = true;
      }
    });
    // Format-checked once each field has a value -- an empty field is
    // already caught (and focused) by the shippingFields loop just above,
    // so this never overwrites that "please enter" message with a format
    // one. Same split as the postal-code format check further below
    // (checkout.errorPostalFormat): "empty" lives in the shared loop with a
    // generic message, "has a value but fails a more specific rule" gets
    // its own block with a dedicated one. Each window.MonarkValidate* below
    // (js/email-popup.js) is the single shared check used site-wide for
    // that field, so a value is never accepted in one form and rejected in
    // another.
    [
      { name: 'firstName', validate: window.MonarkValidateName, key: 'common.errorNameFormat' },
      { name: 'lastName', validate: window.MonarkValidateName, key: 'common.errorNameFormat' },
      { name: 'city', validate: window.MonarkValidateCity, key: 'common.errorCityFormat' },
      { name: 'address', validate: window.MonarkValidateAddress, key: 'common.errorAddressFormat' }
    ].forEach(({ name, validate, key }) => {
      const { input, error } = shippingFields.find((f) => f.input.name === name);
      const val = input.value.trim();
      if (!val) return;
      if (validate && !validate(val)) {
        error.textContent = t(key);
        error.hidden = false;
        if (!firstInvalid) firstInvalid = input;
      } else {
        error.hidden = true;
      }
    });
    // Nudges toward picking an actual Places suggestion instead of
    // free-typed text -- only applies when: Places actually loaded for this
    // visitor at all (placesEnhanced -- never blocks the degraded/no-API-key
    // path, see that flag's own comment in js/places-autocomplete.js), the
    // field currently holds a real, format-valid value (addressError.hidden
    // true, set by the block just above -- an empty or malformed value
    // already has its own message, stacking this one on top would just be
    // confusing/redundant), the current value wasn't the one just selected
    // (placesSelected), and the user hasn't already used the "click
    // here"/manual-entry escape hatch this visit (addressManualOverride).
    if (
      addressInput.dataset.placesEnhanced === 'true' &&
      addressError.hidden &&
      addressInput.dataset.placesSelected !== 'true' &&
      !addressManualOverride
    ) {
      addressSelectNudge.hidden = false;
      if (!firstInvalid) firstInvalid = addressInput;
    } else {
      addressSelectNudge.hidden = true;
    }
    // js/places-autocomplete.js stamps data-places-country on the Address
    // input with the ISO country code (FR/BE/...) of whichever suggestion
    // was last actually selected there, clearing it again the instant the
    // user edits the address by hand (see that file's own comment) -- so a
    // non-empty value here means "this address, as it currently stands, was
    // confirmed by Google to be in this country." Selecting a suggestion
    // already auto-syncs Country to match when it's FR/BE (same file), so
    // this mismatch case is really just the two it can't silently fix:
    // Google having suggested somewhere outside France/Belgium despite the
    // includedRegionCodes restriction, or the user manually changing
    // Country again after a selection already synced it. A manually-typed
    // address (never run through Places at all) has no stamp to check
    // against and is left to whatever Country the user picked, same as
    // before this existed.
    const placesCountry = addressInput.dataset.placesCountry;
    const placesCountryMismatch = placesCountry && placesCountry !== countryInput.value;
    if (!ALLOWED_SHIPPING_COUNTRIES.includes(countryInput.value) || placesCountryMismatch) {
      countryError.hidden = false;
      if (!firstInvalid) firstInvalid = countryInput;
    } else {
      countryError.hidden = true;
    }
    // Format is only checked once the field has a value -- an empty postal
    // code is already caught (and focused) by the shippingFields loop above,
    // so this never overwrites that "please enter" message with a format one.
    const postalVal = postalInput.value.trim();
    if (postalVal) {
      const postalPattern = countryInput.value === 'BE' ? /^\d{4}$/ : /^\d{5}$/;
      if (!postalPattern.test(postalVal)) {
        postalError.textContent = t('checkout.errorPostalFormat', { digits: countryInput.value === 'BE' ? 4 : 5 });
        postalError.hidden = false;
        if (!firstInvalid) firstInvalid = postalInput;
      } else {
        postalError.hidden = true;
      }
    }
    // Phone isn't in shippingFields above (it's optional -- an empty field
    // is fine, see js/phone-input.js's own isValid()) -- only checked for
    // FORMAT when the user actually entered something, and only takes over
    // firstInvalid if every required field already passed, so a phone
    // format error never hides a still-missing required field behind it.
    if (shippingPhoneWidget && !shippingPhoneWidget.isValid()) {
      const phoneCountry = shippingPhoneWidget.getValue().country;
      shippingPhoneError.textContent = t(phoneCountry === 'FR' ? 'phoneInput.errorInvalidFR' : 'phoneInput.errorInvalidGeneric');
      shippingPhoneError.hidden = false;
      if (!firstInvalid) firstInvalid = shippingPhoneWidget;
    } else {
      shippingPhoneError.hidden = true;
    }
    // Works for both cases firstInvalid can hold: a plain <input> (from
    // shippingFields above) and js/phone-input.js's own returned widget
    // object (from the phone check above) -- both expose a .focus() method.
    if (firstInvalid) firstInvalid.focus();
    updateShippingNextBtnState();
    return !firstInvalid;
  }

  function shippingSummaryText() {
    const name = `${form.querySelector('[name="firstName"]').value.trim()} ${form.querySelector('[name="lastName"]').value.trim()}`.trim();
    const city = form.querySelector('[name="city"]').value.trim();
    return t('checkout.accordionShippingSummary', { name, city });
  }

  shippingNextBtn.addEventListener('click', () => {
    if (!validateShippingForm()) return;
    completeAccordionSection('shipping', shippingSummaryText());
    openAccordionSection('payment');
    initStripePayment();
    initPaymentRequestButton();
  });

  // ---------------- Stripe Elements (Payment Element) ----------------
  // Real embedded card payment via the create-checkout-session Supabase
  // Edge Function, which creates/updates a Stripe PaymentIntent server-side
  // -- the amount charged is always computed there from
  // public.products.price × quantity (± a server-validated promo code),
  // never trusted from this page. See that function's own comments for the
  // full contract.
  const stripeErrorEl = document.getElementById('checkout-stripe-error');
  const stripe = window.MonarkStripe || null;
  let stripeElements = null;
  let stripePaymentElement = null;
  let stripeClientSecret = null;
  let stripePaymentIntentId = null;
  let stripeInitPromise = null; // in-flight guard -- see initStripePayment()

  function showStripeError(message) {
    stripeErrorEl.textContent = message;
    stripeErrorEl.hidden = false;
  }

  function stripeLocale() {
    return window.MonarkI18n && window.MonarkI18n.getLang() === 'fr' ? 'fr' : 'en';
  }

  // Colors/fonts pulled from css/style.css's own --bg-void/--accent-bronze-
  // light/--text-on-dark/--text-muted/--font-body/--font-mono -- hardcoded
  // here rather than read via getComputedStyle() because Stripe Elements
  // render inside a sandboxed cross-origin iframe with no access to this
  // page's stylesheet; its appearance API is the only way to style them, and
  // it only accepts literal values, not CSS custom properties. The `fonts`
  // array below is the same reasoning applied to typefaces -- a <link> in
  // this document's own <head> doesn't reach fonts inside that iframe
  // either, so Stripe needs its own cssSrc to fetch and inject them.
  const STRIPE_APPEARANCE = {
    theme: 'night',
    variables: {
      colorPrimary: '#d8b27c',
      colorBackground: '#0a0908',
      colorText: '#ede7dd',
      colorTextSecondary: '#8f887c',
      colorDanger: '#b5675c',
      fontFamily: '"Manrope", sans-serif',
      fontSizeBase: '15px',
      borderRadius: '2px',
      spacingUnit: '4px'
    },
    rules: {
      '.Label': {
        fontFamily: '"IBM Plex Mono", monospace',
        fontSize: '10px',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: '#8f887c'
      },
      '.Input': {
        backgroundColor: 'transparent',
        border: 'none',
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '0',
        boxShadow: 'none',
        padding: '8px 0'
      },
      '.Input:focus': {
        border: 'none',
        borderBottom: '1px solid #d8b27c',
        boxShadow: 'none'
      },
      '.Tab': {
        backgroundColor: 'transparent',
        border: '1px solid rgba(255, 255, 255, 0.08)'
      },
      '.Tab:hover': { border: '1px solid #d8b27c' },
      '.Tab--selected': { backgroundColor: 'rgba(216, 178, 124, 0.1)', border: '1px solid #d8b27c' }
    }
  };

  function mountStripeElements() {
    stripeElements = stripe.elements({
      clientSecret: stripeClientSecret,
      appearance: STRIPE_APPEARANCE,
      locale: stripeLocale(),
      fonts: [{ cssSrc: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap' }]
    });
    stripePaymentElement = stripeElements.create('payment', {
      // Shipping already collected name + address -- Payment Element isn't
      // asked to collect either again.
      fields: { billingDetails: { name: 'never', address: 'never' } },
      // BUG FIX: wallets left unset here used to default to Stripe's own
      // {applePay:'auto', googlePay:'auto', link:'auto'} -- meaning the
      // Payment Element could independently render ITS OWN embedded Link
      // button (Stripe's own official "Payer en toute sécurité avec Link"
      // wording, confirmed live -- not any of this page's own strings) on
      // top of the manual card fields, entirely separate from and in
      // addition to the dedicated Payment Request Button already mounted
      // above (#checkout-payment-request-button, which already covers
      // Apple Pay/Google Pay/Link in one unified, custom-styled,
      // keyboard-accessible component -- see its own comment). Confirmed
      // live (real, non-headless Chrome) that this Payment Element mounts
      // its card fields correctly with no Link session recognized; the
      // reported bug -- Link button + divider + nothing else, no card
      // fields at all -- only reproduces for a session Stripe recognizes as
      // Link-eligible, which this sandbox has no way to simulate (needs
      // real HTTPS + a real Link-registered email). Rather than depend on
      // Stripe's own current (and evidently not always reliable -- see the
      // "legacy wallets integration" deprecation warning this page already
      // logs) behavior for collapsing/expanding manual entry next to its
      // wallet buttons, wallets are explicitly turned off here so this
      // Element only ever renders card fields -- Apple Pay/Google Pay/Link
      // stay exclusively the dedicated PRB's job, never duplicated (or,
      // per the reported bug, substituted) here.
      wallets: { applePay: 'never', googlePay: 'never', link: 'never' }
    });
    stripePaymentElement.mount('#checkout-stripe-payment-element');
  }

  // Called once when the Payment step is first reached (see
  // shippingNextBtn's own handler above), and again on every 'cart:updated'
  // once that's happened (quantity edited via the header's mini-cart, or a
  // promo code applied/removed) -- keeps the PaymentIntent's amount (and
  // therefore what Stripe will actually charge) in sync with whatever the
  // Order Summary is currently showing. Re-invocation reuses the SAME
  // PaymentIntent (passes stripePaymentIntentId back) rather than creating a
  // new one, so the already-mounted Payment Element just needs
  // elements.fetchUpdates() instead of a full remount.
  async function initStripePayment() {
    if (!stripe) {
      showStripeError(t('checkout.stripeInitError'));
      return;
    }
    if (!cart.getCart().length) return;
    // Coalesce overlapping calls (e.g. a fast double-fire of 'cart:updated')
    // onto the same in-flight request rather than racing two PaymentIntent
    // writes against each other.
    if (stripeInitPromise) { await stripeInitPromise; return; }

    stripeInitPromise = (async () => {
      const items = cart.getCart();
      // Payment step is only ever reached once the Account step has already
      // resolved (see the accordion's own STEP_ORDER), so a session always
      // exists here -- userId (logged-in) / guestEmail (guest) let
      // supabase/functions/stripe-webhook attribute the eventual order to
      // the right account/email from the PaymentIntent's own metadata,
      // independent of whether this tab's own recordOrder() call ever runs
      // (see that function's own metadata comment).
      const session = window.MonarkAccount.getSession();
      const { data, error } = await window.MonarkSupabase.functions.invoke('create-checkout-session', {
        body: {
          quantity: items[0].quantity,
          promoCode: cart.getAppliedPromoCode() || undefined,
          paymentIntentId: stripePaymentIntentId || undefined,
          userId: (session && !session.isGuest) ? window.MonarkAccount.getCurrentUserId() || undefined : undefined,
          guestEmail: (session && session.isGuest) ? session.email : undefined,
          // Both guest and logged-in sessions carry an email (see
          // MonarkAccount.getSession()) -- sent unconditionally so
          // supabase/functions/stripe-webhook can send the order-confirmation
          // email without a separate auth.admin lookup for logged-in users.
          // language is this tab's current i18n language at the moment
          // Payment is reached, so the confirmation email matches whatever
          // the customer was actually reading the site in.
          customerEmail: session ? session.email : undefined,
          language: stripeLocale(),
          // Shipping step's own fields (already required + validated before
          // Payment is ever reachable, see STEP_ORDER/validateShippingForm())
          // -- sent the same way customerEmail/language are, purely so
          // supabase/functions/stripe-webhook can print a shipping-address
          // recap in the confirmation email. Read directly off the form
          // here rather than off Stripe's own payment_method.billing_details
          // later, since the Payment Request Button path (Apple Pay/Google
          // Pay) confirms with a wallet-supplied PaymentMethod whose
          // billing_details come from the wallet, not from these exact
          // fields -- reading the form directly is the one path that's
          // identical regardless of which payment method the customer ends
          // up using.
          shippingName: `${form.querySelector('[name="firstName"]').value.trim()} ${form.querySelector('[name="lastName"]').value.trim()}`.trim() || undefined,
          shippingAddressLine1: form.querySelector('[name="address"]').value.trim() || undefined,
          shippingAddressLine2: form.querySelector('[name="extraDetails"]').value.trim() || undefined,
          shippingCity: form.querySelector('[name="city"]').value.trim() || undefined,
          shippingPostalCode: form.querySelector('[name="postal"]').value.trim() || undefined,
          shippingCountry: form.querySelector('[name="country"]').value || undefined
        }
      });
      if (error || !data || !data.clientSecret) {
        console.error('create-checkout-session failed:', error || data);
        showStripeError(t('checkout.stripeInitError'));
        return;
      }
      stripeErrorEl.hidden = true;
      stripePaymentIntentId = data.paymentIntentId;
      stripeClientSecret = data.clientSecret;
      if (!stripeElements) {
        mountStripeElements();
      } else {
        await stripeElements.fetchUpdates();
      }
    })();
    try {
      await stripeInitPromise;
    } finally {
      stripeInitPromise = null;
    }
  }

  document.addEventListener('cart:updated', () => {
    if (stripePaymentIntentId) initStripePayment();
  });

  // Stripe Elements' own locale is fixed at creation time -- a language
  // switch mid-checkout needs a fresh Elements group to pick up the new one.
  // Reuses the same clientSecret (no new PaymentIntent, no Edge Function
  // call) since only the display language changed, not the amount.
  document.addEventListener('monark:langchange', () => {
    if (!stripeElements || !stripeClientSecret) return;
    if (stripePaymentElement) stripePaymentElement.unmount();
    mountStripeElements();
  });

  // ---------------- Stripe Payment Request Button (Apple Pay/Google Pay/Link) ----------------
  // Same stripe.paymentRequest()/canMakePayment() pattern as product.html's
  // own express-buy button (see that page's inline script for the full
  // reasoning behind every choice reused verbatim below) -- one real
  // PaymentRequest, mounted into the single container above the card Payment
  // Element. Reuses the SAME PaymentIntent initStripePayment() already
  // creates/updates for the card form (via stripeClientSecret below) rather
  // than requesting a second one, so either payment method charges the exact
  // same amount and completes through the exact same order-recording path
  // (see completeOrder() further below).
  const prContainer = document.getElementById('checkout-payment-request-button');
  const prDivider = document.getElementById('checkout-payment-request-divider');
  let prEligible = false; // true once canMakePayment() has resolved a real wallet
  let prInitStarted = false; // guards against re-running canMakePayment() on every Payment-step visit
  let prElement = null;
  let prFallbackBtn = null;

  const paymentRequest = stripe ? stripe.paymentRequest({
    country: 'FR',
    currency: 'eur',
    total: { label: cart.PRODUCT.name, amount: Math.round(cart.getFinalTotal() * 100) },
    // Needed to attach this order to an email/name the same way the card
    // form's own Shipping step already does -- Apple Pay/Google Pay/Link all
    // supply this from the payer's own saved wallet info, no extra typing.
    requestPayerName: true,
    requestPayerEmail: true
  }) : null;

  // Keeps the native sheet's own on-screen total in sync with whatever the
  // Order Summary is currently showing (quantity edited via the header's
  // mini-cart, or a promo code applied/removed) -- harmless to call even
  // before any button has ever mounted. The Edge Function still
  // independently computes and charges the authoritative server-side amount
  // (see create-checkout-session) -- this is what keeps the sheet's
  // displayed total matching that.
  function syncPaymentRequestTotal() {
    if (!paymentRequest || !cart.getCart().length) return;
    paymentRequest.update({ total: { label: cart.PRODUCT.name, amount: Math.round(cart.getFinalTotal() * 100) } });
  }
  document.addEventListener('cart:updated', syncPaymentRequestTotal);

  // ---------------- Keyboard-accessible fallback button ----------------
  // Stripe's paymentRequestButton iframe is a confirmed keyboard dead end
  // (cross-origin, so no code on this page can see or intercept a key event
  // once focus is inside it) -- see product.html's own createFallbackButton/
  // preventTabIntoIframe comments for the full investigation. Same fix
  // reused here, scoped to this page's single container instead of that
  // page's main+sticky pair.
  function mountFallbackButton() {
    if (prFallbackBtn) return prFallbackBtn;
    prFallbackBtn = document.createElement('button');
    prFallbackBtn.type = 'button';
    prFallbackBtn.className = 'checkout-payment-request-fallback';
    prFallbackBtn.textContent = t('product.paymentRequestFallback');
    prFallbackBtn.addEventListener('click', () => paymentRequest.show());
    prContainer.appendChild(prFallbackBtn);
    return prFallbackBtn;
  }
  document.addEventListener('monark:langchange', () => {
    if (prFallbackBtn) prFallbackBtn.textContent = t('product.paymentRequestFallback');
  });

  function getPageFocusableElements() {
    return Array.from(document.querySelectorAll('a[href], button, input, textarea, select, summary, iframe')).filter((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = getPageFocusableElements();
    const currentIndex = focusable.indexOf(document.activeElement);
    if (currentIndex === -1) return;
    const target = focusable[e.shiftKey ? currentIndex - 1 : currentIndex + 1];
    if (!target || target.tagName !== 'IFRAME' || !prContainer.contains(target)) return;
    const fallbackBtn = prContainer.querySelector('.checkout-payment-request-fallback');
    if (!fallbackBtn) return;
    e.preventDefault();
    fallbackBtn.focus();
  });

  // Builds (or rebuilds, on a language switch) the actual Stripe Element --
  // separate from initPaymentRequestButton() below so a 'monark:langchange'
  // mid-Payment-step doesn't need to re-run canMakePayment() a second time,
  // exactly matching mountStripeElements()'s own split from initStripePayment().
  function mountPaymentRequestButtonElement() {
    if (prElement) prElement.unmount();
    const prElements = stripe.elements({ locale: stripeLocale() });
    prElement = prElements.create('paymentRequestButton', {
      paymentRequest,
      // theme: 'light'/height: '52px' match product.html's own main button --
      // see that page's comment on why 52px is the correct, non-arbitrary value.
      style: { paymentRequestButton: { type: 'default', theme: 'light', height: '52px' } }
    });
    prElement.mount(prContainer);
    const iframe = prContainer.querySelector('iframe');
    const fallbackBtn = mountFallbackButton();
    if (iframe) {
      iframe.tabIndex = -1;
      iframe.addEventListener('focus', () => fallbackBtn.focus());
    }
  }

  // Called once, the first time the Payment step is reached (see
  // shippingNextBtn's own handler above) -- canMakePayment() resolves null
  // with nothing available whenever the page isn't served over HTTPS, Apple
  // Pay specifically hasn't had its domain registered with Stripe yet, or the
  // browser/device genuinely has no eligible wallet configured. Both the
  // button and the "or" divider stay hidden and leave no gap when that
  // happens -- the card Payment Element below is completely unaffected
  // either way. The info log below is left in (not a temporary debug line)
  // specifically so a "why isn't this showing" question is
  // self-diagnosable from the browser console instead of a silent no-op.
  function initPaymentRequestButton() {
    if (prInitStarted || !paymentRequest || !prContainer) return;
    prInitStarted = true;
    paymentRequest.canMakePayment().then((result) => {
      if (!result) {
        console.info('Payment Request Button: no eligible wallet (Apple Pay/Google Pay/Link) for this browser/page -- requires HTTPS and a configured wallet; Apple Pay additionally requires domain registration with Stripe.');
        return;
      }
      prEligible = true;
      // Unhide BEFORE mount() -- mounting into a still-hidden (display:none
      // at that instant) container risks Stripe measuring/initializing the
      // iframe against a 0x0 layout box it never revisits once the container
      // becomes visible a tick later (confirmed live on product.html).
      prContainer.hidden = false;
      prDivider.hidden = false;
      mountPaymentRequestButtonElement();
    }).catch((err) => {
      console.error('Payment Request Button: canMakePayment() failed:', err && err.message);
    });
  }

  document.addEventListener('monark:langchange', () => {
    if (!prEligible) return;
    mountPaymentRequestButtonElement();
  });

  // ---------------- Real payment confirmation ----------------
  // 'paymentmethod' fires once the user's already authenticated in the
  // native sheet (Face ID/Touch ID/etc.) -- a PaymentMethod exists, but
  // nothing has been charged yet. A session always exists by the time this
  // button is even visible (Payment step is only reachable after Account has
  // resolved, see STEP_ORDER above) -- unlike product.html's own version of
  // this handler, there's no need to fall back to the full checkout flow for
  // a missing email here, this already IS that flow.
  if (paymentRequest) {
    paymentRequest.on('paymentmethod', async (ev) => {
      const session = window.MonarkAccount.getSession();
      if (!session) { ev.complete('fail'); return; }

      // Reuses initStripePayment()'s own in-flight/already-created
      // PaymentIntent instead of creating a second one -- idempotent (keyed
      // off stripePaymentIntentId), so this is a cheap no-op if the card
      // Payment Element already finished initializing moments ago.
      await initStripePayment();
      if (!stripeClientSecret) {
        ev.complete('fail');
        showStripeError(t('checkout.stripeNotReady'));
        return;
      }

      try {
        const { error: confirmError, paymentIntent } = await stripe.confirmCardPayment(
          stripeClientSecret,
          { payment_method: ev.paymentMethod.id },
          { handleActions: false }
        );
        if (confirmError) {
          console.error('Payment Request Button confirmCardPayment failed:', confirmError.message);
          ev.complete('fail');
          showStripeError(confirmError.message || t('checkout.stripeGenericError'));
          return;
        }
        // Closes the native sheet -- must happen regardless of status below,
        // per Stripe's own documented pattern for this event.
        ev.complete('success');

        let finalIntent = paymentIntent;
        if (finalIntent.status === 'requires_action') {
          // 3D Secure or similar -- the native sheet is already closed at
          // this point (ev.complete() above), so Stripe's own
          // redirect/challenge UI (if any) takes over from here.
          const { error: actionError, paymentIntent: confirmedIntent } = await stripe.confirmCardPayment(stripeClientSecret);
          if (actionError || !confirmedIntent) return;
          finalIntent = confirmedIntent;
        }
        if (finalIntent.status !== 'succeeded') return;

        // Payment succeeded -- completes the order the exact same way the
        // card <form> submit below does (see completeOrder()), just reading
        // name values from the same Shipping fields that flow already
        // validated before Payment ever became reachable.
        const items = cart.getCart();
        const finalTotal = cart.getFinalTotal();
        const appliedCode = cart.getAppliedPromoCode();
        const firstNameVal = form.querySelector('[name="firstName"]').value.trim();
        const lastNameVal = form.querySelector('[name="lastName"]').value.trim();
        await completeOrder(session, { quantity: items[0].quantity, finalTotal, appliedCode, firstNameVal, lastNameVal });
      } catch (err) {
        console.error('Payment Request Button confirm failed:', err);
        ev.complete('fail');
      }
    });
  }

  // One consistent two-decimal formatter for every price on this page --
  // was a whole-euro money() plus a separate moneyCents() only for the
  // shipping fee, which made every other line (Subtotal, discounts, Total)
  // silently round to the nearest euro instead of showing exact figures.
  // €-prefix + period-decimal matches product.html's own .shop-price
  // convention (see css/shop.css); toLocaleString adds a thousands comma
  // too, for whenever a quantity pushes a total into four figures.
  function money(n) {
    return '€' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Flat, mocked shipping fee -- always waived (France-only, no threshold).
  // Shown struck through next to "Free" so the waived cost is visible, and
  // folded into the struck-through original total below -- never added to
  // any actual charged total.
  const SHIPPING_FEE = 5.90;

  // French standard VAT rate -- purely a display line ("TVA offerte"),
  // same waived-fee treatment as SHIPPING_FEE above: shown struck through
  // next to "Free" for marketing effect, never added to or subtracted from
  // any actual charged total (cart.PRODUCT.price is already the real,
  // all-inclusive price charged).
  const VAT_RATE = 0.20;

  function showPromoMessage(el, text, kind) {
    el.textContent = text;
    el.className = 'promo-message promo-message-' + kind;
    el.hidden = false;
  }

  // Product-photo/name/qty block -- shared by the desktop Order Summary
  // column and the mobile-only Paiement section's own "Panier" sub-block
  // (point 3), so both ever only have one place defining this markup.
  function summaryItemHtml(item) {
    return `
      <div class="checkout-summary-item">
        <img class="checkout-summary-thumb" src="${cart.PRODUCT.image}" alt="${cart.PRODUCT.name}" width="2880" height="2880" loading="lazy">
        <div class="checkout-summary-item-details">
          <p class="checkout-summary-item-name">${cart.PRODUCT.name}</p>
          <p class="checkout-summary-item-qty">${t('checkout.qty')} ${item.quantity}</p>
        </div>
      </div>
    `;
  }

  // Countdown note inside the "Limited-Time Offer" line below -- separate
  // from that line's own discount amount (siteDiscount is a permanent,
  // already-applied price reduction, not something that stops applying when
  // the countdown does; only the ticking note itself is countdown-driven).
  // getRemainingSeconds() returning null (js/promo-countdown.js) covers both
  // "not resolved yet" (page just loaded) and "resolved hidden" (fixed_end_date
  // already passed) -- checkoutCountdownHidden additionally guards the
  // hidden case explicitly so a stale non-null value from before the
  // subscribe() callback below flips it can't leak through on a later
  // cart-change re-render.
  function countdownNoteHtml() {
    if (checkoutCountdownHidden || !window.MonarkPromoCountdown) return '';
    const secs = window.MonarkPromoCountdown.getRemainingSeconds();
    if (secs === null) return '';
    return `<span class="checkout-promo-countdown-note">${t('promoBanner.endsIn')}<span class="promo-countdown-value checkout-promo-countdown-value">${window.MonarkPromoCountdown.formatCountdown(secs)}</span></span>`;
  }

  // Subtotal/Shipping/discount/Total lines -- shared by the desktop column,
  // the mobile Paiement section, AND the Billing section's own recap (point
  // 4), so all three stay trivially in sync (same data, one function, all
  // three re-rendered together in renderSummary() below).
  function summaryLinesHtml(item) {
    const subtotal = item.quantity * cart.PRODUCT.price;
    const promoCode = cart.getAppliedPromoCode();
    const discount = cart.getDiscountAmount();
    const total = cart.getFinalTotal();
    // Site-wide -21% offer is already baked into cart.PRODUCT.price itself
    // (subtotal above is the discounted figure) -- this is purely the
    // informational savings amount, not a further deduction from total.
    const siteDiscount = cart.getSiteDiscountAmount();
    // Display-only VAT amount "included" in the subtotal -- never folded into
    // the real charged `total` above, exactly like SHIPPING_FEE.
    const vatAmount = subtotal * VAT_RATE;
    // The "if you'd paid full price" reference total: original (undiscounted)
    // product price + the real (waived) shipping fee + the waived VAT amount,
    // deliberately ignoring any promo code -- that's a further discount on
    // top of, not part of, "original" pricing. Every struck-through figure
    // shown above (shipping, VAT) is folded in here so the struck total adds
    // up to the sum of the other struck-through lines.
    const originalTotal = cart.getOriginalCartTotal() + SHIPPING_FEE + vatAmount;

    const discountLine = promoCode ? `
      <div class="checkout-summary-line checkout-summary-discount">
        <span>${t('checkout.promoLabel', { code: promoCode })}</span>
        <span>&minus;${money(discount)}</span>
      </div>
    ` : '';

    return `
      <div class="checkout-summary-line">
        <span>${t('checkout.subtotal')}</span>
        <span>${money(subtotal)}</span>
      </div>
      <div class="checkout-summary-line">
        <span>${t('checkout.shipping')}</span>
        <span><span class="checkout-summary-strike">${money(SHIPPING_FEE)}</span> <span class="checkout-summary-shipping-free">${t('checkout.free')}</span></span>
      </div>
      <div class="checkout-summary-line">
        <span>${t('checkout.vat')}</span>
        <span><span class="checkout-summary-strike">${money(vatAmount)}</span> <span class="checkout-summary-shipping-free">${t('checkout.free')}</span></span>
      </div>
      <div class="checkout-summary-line checkout-summary-discount checkout-summary-discount-with-countdown">
        <span>${t('checkout.limitedTimeOffer')}</span>
        <span>&minus;${money(siteDiscount)}</span>
        ${countdownNoteHtml()}
      </div>
      ${discountLine}
      <div class="checkout-summary-line checkout-summary-total">
        <span>${t('checkout.total')}</span>
        <span><span class="checkout-summary-strike">${money(originalTotal)}</span> ${money(total)}</span>
      </div>
    `;
  }

  function renderSummary() {
    const items = cart.getCart();

    if (!items.length) {
      const emptyHtml = `<p class="checkout-empty-note">${t('checkout.emptyCartNote')}</p>`;
      summaryEl.innerHTML = emptyHtml;
      mobileCartEl.innerHTML = '';
      mobileTotalsEl.innerHTML = emptyHtml;
      billingRecapEl.innerHTML = '';
      submitBtn.disabled = true;
      promoForm.hidden = true;
      mobilePromoForm.hidden = true;
      billingPromoBox.hidden = true;
      return;
    }

    submitBtn.disabled = false;
    promoForm.hidden = false;
    mobilePromoForm.hidden = false;
    billingPromoBox.hidden = false;

    const item = items[0]; // single product for now
    const itemHtml = summaryItemHtml(item);
    const linesHtml = summaryLinesHtml(item);

    // Desktop Order Summary column -- item, then totals (unchanged from
    // before this refactor).
    summaryEl.innerHTML = itemHtml + linesHtml;
    // Mobile Paiement section -- "Panier" sub-block gets the item, the rest
    // of the section's own body gets the totals (Promo Code form sits after
    // both in the HTML, see the markup comment there).
    mobileCartEl.innerHTML = itemHtml;
    mobileTotalsEl.innerHTML = linesHtml;
    // Billing recap -- totals only, no product photo/qty (its own mobile-only
    // fallback Promo Code control lives right after it in the HTML, kept in
    // sync the same way as the other two below).
    billingRecapEl.innerHTML = linesHtml;

    // Keeps every promo input's displayed value in sync with whichever one
    // was actually just used -- applyPromoCode()/removePromoCode() both
    // dispatch 'cart:updated' (see js/cart.js), which is what re-runs this
    // function, so this always reflects the current applied code regardless
    // of which of the three the user typed it into.
    const appliedCode = cart.getAppliedPromoCode();
    if (appliedCode) {
      promoInput.value = appliedCode;
      mobilePromoInput.value = appliedCode;
      billingPromoInput.value = appliedCode;
    }
  }

  // Core apply-a-code logic, shared by every promo control on this page
  // regardless of how each one triggers it (a real <form> submit for the
  // desktop column and the mobile Paiement section, vs. a plain button
  // click for Billing's own -- see wirePromoForm()/wireBillingPromoTrigger()
  // below and the HTML comment on why Billing's can't be a <form>).
  // Async now -- cart.applyPromoCode() validates against the server (see
  // supabase/functions/validate-promo-code) instead of a local hardcoded map.
  //
  // submitBtn is disabled alongside inputEl for the duration of the call --
  // same disable-input-and-button pattern as js/account.js's own email step
  // (single dominant field per form here too). Takes it as a parameter
  // (rather than deriving it from inputEl's own form) since Billing's own
  // control isn't a <form> at all (see wireBillingPromoTrigger below) --
  // every call site already has its own button reference on hand regardless.
  async function attemptApplyPromo(inputEl, messageEl, submitBtn) {
    inputEl.disabled = true;
    submitBtn.disabled = true;
    try {
      const result = await cart.applyPromoCode(inputEl.value);
      if (result.ok) {
        inputEl.value = result.code;
        showPromoMessage(messageEl, t('checkout.promoSuccess', { percent: Math.round(result.rate * 100) }), 'success');
      } else {
        showPromoMessage(messageEl, t('checkout.promoInvalid'), 'error');
      }
    } finally {
      inputEl.disabled = false;
      submitBtn.disabled = false;
    }
  }

  function wirePromoForm(formEl, inputEl, messageEl) {
    const submitBtn = formEl.querySelector('button[type="submit"]');
    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      attemptApplyPromo(inputEl, messageEl, submitBtn);
    });
  }
  wirePromoForm(promoForm, promoInput, promoMessage);
  wirePromoForm(mobilePromoForm, mobilePromoInput, mobilePromoMessage);

  // Billing's fallback promo control is a plain <div> (can't be a <form>,
  // see its own HTML comment), so there's no native submit event to hook --
  // wired directly off the Apply button's click, plus Enter-in-the-input for
  // the same one-key-press UX a real form would give for free. Both paths
  // share the exact same billingPromoApplyBtn reference, so the loading
  // state applies identically regardless of which one fired it.
  billingPromoApplyBtn.addEventListener('click', () => attemptApplyPromo(billingPromoInput, billingPromoMessage, billingPromoApplyBtn));
  billingPromoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      attemptApplyPromo(billingPromoInput, billingPromoMessage, billingPromoApplyBtn);
    }
  });

  document.addEventListener('cart:updated', renderSummary);
  // Rebuilds the whole summary (its labels are baked into the template
  // string above, not data-i18n-tagged elements MonarkI18n.apply() could
  // re-walk on its own) -- same pattern js/cart-widget.js's render() already
  // uses for its own template-string content.
  document.addEventListener('monark:langchange', renderSummary);
  renderSummary();

  // Same shared countdown js/promo-banner.js's own banner (and product.html's
  // own price-note display) subscribes to (see js/promo-countdown.js) --
  // always the exact same remaining time, never a second independent timer.
  // Looks up .checkout-promo-countdown-value fresh on every tick (rather than
  // caching the element once) since renderSummary() fully replaces all three
  // summary containers' innerHTML on every cart change/language switch,
  // which would otherwise leave this writing into detached, no-longer-visible
  // nodes after the very first re-render.
  // formatCountdownHTML() (js/promo-countdown.js) wraps each unit in its own
  // span -- seconds gets the continuous pulse, hours/minutes get a one-shot
  // fade/scale-in only on the tick their own value actually changed (see
  // that file's own comment on the shared `changed` computation).
  if (window.MonarkPromoCountdown) {
    window.MonarkPromoCountdown.subscribe(
      (secs, changed) => {
        const html = window.MonarkPromoCountdown.formatCountdownHTML(secs, changed);
        document.querySelectorAll('.checkout-promo-countdown-value').forEach((el) => {
          el.innerHTML = html;
        });
      },
      () => {
        // admin.html's Timer tab has a fixed_end_date that's already passed
        // -- re-render once so countdownNoteHtml() (this file's own, above)
        // drops the note from every summary container it's currently in.
        checkoutCountdownHidden = true;
        renderSummary();
      }
    );
  }

  const termsCheckbox = document.getElementById('checkout-terms-checkbox');
  const termsError = document.getElementById('checkout-terms-error');
  termsCheckbox.addEventListener('change', () => { termsError.hidden = true; });

  // Shared order-completion path -- runs once real (test-mode) money has
  // actually moved, regardless of which payment method got it there (this
  // <form>'s own submit handler below, or the Payment Request Button's
  // 'paymentmethod' handler further above): profile backfill, order-history
  // row, cart teardown, then the same confirmation view either path ends on.
  async function completeOrder(session, { quantity, finalTotal, appliedCode, firstNameVal, lastNameVal }) {
    // Non-guest only: a guest has no profile row to backfill.
    if (!session.isGuest) {
      const account = await window.MonarkAccount.findAccount(session.email);
      // Silent background fill of MISSING profile data only -- never
      // overwrites a first/last name the account already has on file, per
      // this feature's own spec. No UI, no confirmation message; the next
      // visit to account.html's Edit Profile just already shows it filled in.
      const profilePatch = {};
      if (account && !account.firstName && firstNameVal) profilePatch.firstName = firstNameVal;
      if (account && !account.lastName && lastNameVal) profilePatch.lastName = lastNameVal;
      // Same silent, missing-only backfill for the phone/country Shipping
      // collected -- never overwrites a phone number already on file (e.g.
      // one entered at account creation).
      if (account && !account.phone && shippingPhoneWidget) {
        const phoneVal = shippingPhoneWidget.getValue();
        if (phoneVal.number) {
          profilePatch.phone = phoneVal.number;
          profilePatch.dialCode = phoneVal.dialCode;
          profilePatch.country = phoneVal.country;
        }
      }
      if (Object.keys(profilePatch).length) await window.MonarkAccount.updateAccount(session.email, profilePatch);
    }

    // One order-history entry per completed checkout -- tied to the account
    // for a logged-in session, or to session.email as a guest_email row
    // otherwise (see js/account.js's recordOrder()). Single product line for
    // now, matching every other "single product for now" comment already in
    // this file. paymentIntentId is what lets supabase/functions/
    // stripe-webhook reconcile onto this exact row instead of creating a
    // second one once it independently confirms the same payment -- see
    // that function's own comment.
    await window.MonarkAccount.recordOrder(session, {
      productName: cart.PRODUCT.name,
      quantity,
      total: finalTotal,
      promoCode: appliedCode || null,
      paymentIntentId: stripePaymentIntentId
    });

    cart.clearCart();
    cart.removePromoCode();
    formState.hidden = true;
    confirmation.hidden = false;
    // Overwrites the h1's own data-i18n="checkout.title" content directly --
    // removeAttribute keeps a later language switch (MonarkI18n.apply(document))
    // from stomping this back to "Checkout"/"Commande" once the order's
    // already been placed.
    title.removeAttribute('data-i18n');
    title.textContent = t('checkout.thankYou');
    confirmationTotal.textContent = appliedCode
      ? t('checkout.confirmationTotalWithCode', { total: money(finalTotal), code: appliedCode })
      : t('checkout.confirmationTotal', { total: money(finalTotal) });
    // Swapping to the confirmation state doesn't itself move the viewport, so if
    // the user had scrolled down to fill in the lower parts of the form, the
    // title/confirmation would render wherever that scroll position happened to
    // land -- sometimes cutting the title off above the fold.
    window.scrollTo(0, 0);
    pollForOrderReference(session, stripePaymentIntentId);
  }

  // recordOrder() only ever inserts a 'processing' row (see its own
  // comment) -- the reference_number shown here doesn't exist yet at the
  // exact moment this page renders the confirmation; it only gets assigned
  // once supabase/functions/stripe-webhook independently confirms the same
  // PaymentIntent server-side, which can take anywhere from under a second
  // to several seconds after Stripe actually receives the webhook. Rather
  // than leaving the confirmation screen permanently silent about it, this
  // polls a few times over a bounded window and fills it in live if/when it
  // shows up -- gives up quietly (no error, no "still waiting" message) if
  // it doesn't land in time, since the payment itself already succeeded
  // regardless and this is purely a nice-to-have.
  //
  // Logged-in sessions only: getOrders() is the same RLS-scoped read
  // account.html's own Order History already uses (auth.uid() = user_id),
  // which a guest session has no equivalent of -- there's no safe way for
  // this tab to read back its OWN just-placed guest order without either a
  // new client-readable RLS policy on public.orders (a real risk: guest
  // orders have no auth to prove ownership by, so opening that up would let
  // anyone who can guess/obtain a guest's order id read it) or a dedicated
  // Edge Function built solely for this. Neither felt justified for a
  // purely cosmetic confirmation-screen enhancement, so guests simply don't
  // see a reference number here today -- they'd still see the definitive
  // 'paid' order once/if this project ever adds a way for guests to look
  // their own order up (e.g. by email + order id).
  const ORDER_REFERENCE_POLL_INTERVAL_MS = 2500;
  const ORDER_REFERENCE_POLL_MAX_ATTEMPTS = 6; // ~15s total
  async function pollForOrderReference(session, paymentIntentId) {
    if (session.isGuest || !paymentIntentId) return;
    for (let attempt = 0; attempt < ORDER_REFERENCE_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, ORDER_REFERENCE_POLL_INTERVAL_MS));
      // Bail if the visitor has already navigated away from the
      // confirmation view (e.g. clicked "Back to The Experience") --
      // nothing left to update.
      if (confirmation.hidden) return;
      const orders = await window.MonarkAccount.getOrders(session.email);
      const match = orders.find((o) => o.paymentIntentId === paymentIntentId);
      if (match && match.referenceNumber) {
        confirmationReference.textContent = t('checkout.confirmationReference', { reference: match.referenceNumber });
        confirmationReference.hidden = false;
        return;
      }
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!cart.getCart().length) return;
    // The buyer's email lives in the account session (js/account.js), not a
    // shipping-form field -- the account step above already collected and
    // validated it, so it isn't asked twice. This form is hidden until that
    // step resolves, but the guard costs nothing and reads better than
    // assuming a session must exist by the time submit fires.
    const session = window.MonarkAccount.getSession();
    if (!session) return;
    // Re-validated here too, not just gating the Next Step button -- Shipping
    // and Payment share this one <form>, so pressing Enter inside a shipping
    // field submits it directly, bypassing Next Step entirely.
    if (!validateShippingForm()) {
      openAccordionSection('shipping');
      return;
    }
    if (!termsCheckbox.checked) {
      termsError.hidden = false;
      termsCheckbox.focus();
      return;
    }
    termsError.hidden = true;

    if (!stripe || !stripeElements || !stripeClientSecret) {
      // Payment Element never finished initializing (Edge Function call
      // failed, or the user reached Place Order before it resolved) --
      // nothing to confirm against. initStripePayment()'s own error is
      // already shown in this case; this covers the rest.
      showStripeError(t('checkout.stripeNotReady'));
      return;
    }
    stripeErrorEl.hidden = true;

    // SECURITY (placeholder): this form has no spam/abuse protection beyond
    // what Supabase Auth/RLS and Stripe's own fraud tooling already provide
    // -- add a honeypot field (hidden input real users never fill in;
    // silently reject if non-empty) and rate-limit submissions per
    // IP/session at some point. See README.md's "Forms" section.
    const items = cart.getCart();
    const finalTotal = cart.getFinalTotal();
    const appliedCode = cart.getAppliedPromoCode();
    const firstNameVal = form.querySelector('[name="firstName"]').value.trim();
    const lastNameVal = form.querySelector('[name="lastName"]').value.trim();

    // Disabled for the duration of the awaits below -- these are all real
    // network calls now (not the instant, synchronous mock this button was
    // originally built against), so without this a second click before they
    // resolve could fire a duplicate charge/order.
    submitBtn.disabled = true;
    try {
      // Real payment confirmation. redirect: 'if_required' keeps this
      // embedded (no full-page navigation) for card payments, which
      // essentially never need one; return_url is still required by the API
      // as a fallback for a payment method that DOES redirect, even though
      // payment_method_types is restricted to ['card'] server-side (see the
      // Edge Function) -- Apple Pay/etc. are a later follow-up, not reachable
      // this round. Billing name/address reuse what Shipping already
      // collected (Payment Element itself asks for neither -- see its own
      // `fields` option in mountStripeElements()), including the Shipping
      // step's own France/Belgium country <select> -- validateShippingForm()
      // above already guarantees this is 'FR' or 'BE' by the time Place
      // Order can be reached.
      const { error: stripeConfirmError, paymentIntent } = await stripe.confirmPayment({
        elements: stripeElements,
        confirmParams: {
          return_url: window.location.href,
          payment_method_data: {
            billing_details: {
              name: `${firstNameVal} ${lastNameVal}`.trim(),
              address: {
                line1: form.querySelector('[name="address"]').value.trim(),
                line2: form.querySelector('[name="extraDetails"]').value.trim() || undefined,
                city: form.querySelector('[name="city"]').value.trim(),
                postal_code: form.querySelector('[name="postal"]').value.trim(),
                // Stripe requires every address sub-field once
                // fields.billingDetails.address is 'never' at Element
                // creation (see mountStripeElements()) -- state isn't part
                // of this form (France/Belgium addresses don't use it) but
                // still has to be present, even empty, or confirmPayment()
                // throws an IntegrationError rather than just treating it
                // as omitted.
                state: '',
                country: form.querySelector('[name="country"]').value
              }
            }
          }
        },
        redirect: 'if_required'
      });

      if (stripeConfirmError) {
        // Stripe's own message is already a decent, human-readable string
        // ("Your card was declined.", "Your card's expiration year is
        // invalid.", etc.) -- shown directly rather than mapped through
        // i18n, same as js/account.js leaves Supabase's own auth error text
        // alone where there's no cleaner mapping. Falls back to a generic
        // message for the rare case Stripe doesn't supply one.
        showStripeError(stripeConfirmError.message || t('checkout.stripeGenericError'));
        return;
      }
      if (!paymentIntent || paymentIntent.status !== 'succeeded') {
        showStripeError(t('checkout.stripeGenericError'));
        return;
      }

      // Payment succeeded -- completes the order the exact same way the
      // Payment Request Button's own 'paymentmethod' handler above does
      // (see completeOrder()).
      await completeOrder(session, { quantity: items[0].quantity, finalTotal, appliedCode, firstNameVal, lastNameVal });
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
