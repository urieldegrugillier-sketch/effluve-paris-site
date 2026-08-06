(function () {
  const account = window.MonarkAccount;
  function t(key, vars) { return window.MonarkI18n ? window.MonarkI18n.t(key, vars) : key; }
  // Same two-decimal €-prefixed formatter as checkout.html's own money() --
  // duplicated rather than shared since the two pages don't share a script.
  function money(n) {
    return '€' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Delegates to the single canonical email-format check (js/email-popup.js
  // -- see that file's own comment on window.MonarkValidateEmail), same as
  // js/account.js's own mountAccountGate() uses for the initial login/
  // create-account step; this page's Edit Profile email field used to keep
  // a separate, looser copy of the same regex instead of sharing that one.
  function isValidEmail(value) { return window.MonarkValidateEmail ? window.MonarkValidateEmail(value) : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
  // Same floor as js/account.js's own createAccount() password rule (8+
  // chars, at least one letter, one number, and one special character from
  // !@#$%&*) -- Edit Profile's "same validation as account creation"
  // requirement, duplicated here rather than exported from account.js since
  // it's also re-declared privately inside that file's own
  // mountAccountGate() closure, not part of its public API. No live
  // requirements checklist on THIS field (that's create-account-only, see
  // js/account.js) -- only the rule itself needs to stay in sync, so a
  // password accepted at signup is never later rejected (or vice versa)
  // when changed here.
  function isValidPassword(value) { return value.length >= 8 && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && /[!@#$%&*]/.test(value); }

  const profileSection = document.getElementById('account-profile');
  const profileForm = document.getElementById('account-profile-form');
  const profileEmailInput = profileForm.querySelector('[name="email"]');
  const profilePasswordInput = profileForm.querySelector('[name="password"]');
  const profileFirstNameInput = profileForm.querySelector('[name="firstName"]');
  const profileLastNameInput = profileForm.querySelector('[name="lastName"]');
  const profileDobInput = profileForm.querySelector('[name="dob"]');
  const profileSubmitBtn = document.getElementById('account-profile-submit-btn');
  const profileEmailError = document.getElementById('account-profile-email-error');
  const profilePasswordError = document.getElementById('account-profile-password-error');
  const profileFirstNameError = document.getElementById('account-profile-firstName-error');
  const profileLastNameError = document.getElementById('account-profile-lastName-error');
  const profileSuccess = document.getElementById('account-profile-success');

  const addressSection = document.getElementById('account-address');
  const addressForm = document.getElementById('account-address-form');
  const addressInput = addressForm.querySelector('[name="address"]');
  const addressFieldError = document.getElementById('account-address-address-error');
  const addressSelectNudge = document.getElementById('account-address-select-nudge');
  // Same page-lifetime-only "click here" escape hatch as checkout.html's own
  // copy of this field -- see that page's own comment on why this isn't
  // localStorage (it's "same visit," per spec, not "remembered forever").
  let addressManualOverride = false;
  addressSelectNudge.addEventListener('click', (e) => {
    if (!e.target.closest('.checkout-address-manual-link')) return;
    addressManualOverride = true;
    addressSelectNudge.hidden = true;
  });
  // Retyping invalidates any prior selection (js/places-autocomplete.js's
  // own 'input' listener clears placesSelected) -- hide a stale nudge from a
  // previous submit attempt rather than leaving it displayed against text
  // that's since changed; the submit handler below decides fresh each time.
  addressInput.addEventListener('input', () => { addressSelectNudge.hidden = true; });
  // Renamed from address2Input/name="address2" -- see that field's own
  // markup comment (Chrome autofill heuristic fix).
  const extraDetailsInput = addressForm.querySelector('[name="extraDetails"]');
  const cityInput = addressForm.querySelector('[name="city"]');
  const cityError = document.getElementById('account-address-city-error');
  const postalInput = addressForm.querySelector('[name="postal"]');
  const addressPhoneError = document.getElementById('account-address-phone-error');
  const addressSubmitBtn = document.getElementById('account-address-submit-btn');
  // Same "shared, not duplicated" component as checkout.html's own Shipping
  // phone field and the account-gate's create-account phone field (see
  // js/phone-input.js) -- was still a plain <input type="tel"> here.
  const addressPhoneWidget = window.MonarkPhoneInput
    ? window.MonarkPhoneInput.mount(document.getElementById('account-phone'), {
      onChange: () => { addressPhoneError.hidden = true; }
    })
    : null;
  const addressSuccess = document.getElementById('account-address-success');

  const paymentSection = document.getElementById('account-payment');
  const paymentForm = document.getElementById('account-payment-form');
  const cardNameInput = paymentForm.querySelector('[name="cardName"]');
  const cardNameError = document.getElementById('account-payment-cardName-error');
  const cardNumberInput = paymentForm.querySelector('[name="cardNumber"]');
  const cardExpiryInput = paymentForm.querySelector('[name="cardExpiry"]');
  const paymentSubmitBtn = document.getElementById('account-payment-submit-btn');
  const paymentSuccess = document.getElementById('account-payment-success');

  const preferencesSection = document.getElementById('account-preferences');
  const preferencesForm = document.getElementById('account-preferences-form');
  const marketingToggle = document.getElementById('account-marketing-toggle');
  const preferencesSubmitBtn = document.getElementById('account-preferences-submit-btn');
  const preferencesSuccess = document.getElementById('account-preferences-success');

  const adminModeBtn = document.getElementById('account-admin-mode-btn');
  const orderHistory = document.getElementById('account-order-history');
  const guestOrderNote = document.getElementById('account-order-history-guest-note');
  const guestCreateBtn = document.getElementById('account-guest-create-btn');
  const orderHistoryContent = document.getElementById('account-order-history-content');
  const noOrdersNote = document.getElementById('account-no-orders');
  const orderList = document.getElementById('account-order-list');

  const dangerSection = document.getElementById('account-danger');
  const deleteBtn = document.getElementById('account-delete-btn');
  const deleteConfirmBlock = document.getElementById('account-delete-confirm');
  const deleteConfirmBtn = document.getElementById('account-delete-confirm-btn');
  const deleteCancelBtn = document.getElementById('account-delete-cancel-btn');

  function resetDeleteConfirm() { deleteConfirmBlock.hidden = true; }

  // Order History is shown for every resolved session, but guests see a
  // dedicated prompt instead of the real list (see showExtras() below) --
  // this only ever runs for a non-guest session now.
  async function renderOrders(email) {
    const orders = await account.getOrders(email);
    if (!orders.length) {
      noOrdersNote.hidden = false;
      orderList.hidden = true;
      orderList.innerHTML = '';
      return;
    }
    noOrdersNote.hidden = true;
    orderList.hidden = false;
    const locale = window.MonarkI18n && window.MonarkI18n.getLang() === 'fr' ? 'fr-FR' : 'en-US';
    // Most-recent-first is already account.getOrders()'s own contract (see
    // that function's comment) -- this just renders in the order it's given.
    orderList.innerHTML = orders.map((order) => {
      const dateStr = new Date(order.date).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
      // referenceNumber is only ever set once supabase/functions/stripe-webhook
      // has reconciled this order to 'paid' (see js/account.js's getOrders()
      // own comment) -- absent means that hasn't landed yet (order still
      // 'processing'), not an error, so this line is just skipped rather
      // than shown blank/placeholder.
      const referenceLine = order.referenceNumber
        ? `<p class="account-order-reference">${t('account.orderReference', { reference: order.referenceNumber })}</p>`
        : '';
      return `
        <li class="account-order-item">
          <p class="account-order-date">${t('account.orderDate', { date: dateStr })}</p>
          ${referenceLine}
          <p class="account-order-product">${order.productName}</p>
          <p class="account-order-meta">
            <span>${t('account.orderQty', { qty: order.quantity })}</span>
            <span>${t('account.orderTotalLine', { total: money(order.total) })}</span>
          </p>
        </li>
      `;
    }).join('');
  }

  // Populates Edit Profile/Address/Preferences from the account's current
  // stored values -- called fresh every time the gate resolves to a
  // non-guest session (mount, and after every log-in/guest-to-account
  // switch/create), so it's never showing stale data left over from a
  // previously logged-in account on a shared machine.
  async function renderProfile(email) {
    const acc = await account.findAccount(email);
    if (!acc) return;
    profileEmailInput.value = acc.email;
    profilePasswordInput.value = '';
    profileFirstNameInput.value = acc.firstName || '';
    profileLastNameInput.value = acc.lastName || '';
    profileDobInput.value = acc.dob || '';
    profileEmailError.hidden = true;
    profilePasswordError.hidden = true;
    profileFirstNameError.hidden = true;
    profileLastNameError.hidden = true;
    profileSuccess.hidden = true;

    addressInput.value = acc.address || '';
    extraDetailsInput.value = acc.extraDetails || '';
    cityInput.value = acc.city || '';
    postalInput.value = acc.postal || '';
    if (addressPhoneWidget) addressPhoneWidget.setValue({ number: acc.phone || '', country: acc.country || 'FR' });
    addressFieldError.hidden = true;
    cityError.hidden = true;
    addressPhoneError.hidden = true;
    addressSuccess.hidden = true;

    cardNameInput.value = acc.cardName || '';
    cardNumberInput.value = acc.cardNumber || '';
    cardExpiryInput.value = acc.cardExpiry || '';
    cardNameError.hidden = true;
    paymentSuccess.hidden = true;

    // acc.marketingOptIn defaults true for every account created since this
    // feature shipped (see account.js's createAccount()) -- the `!== false`
    // check is only for accounts that predate it, so an old record without
    // the field at all still reads as opted-in rather than silently opted-out.
    marketingToggle.checked = acc.marketingOptIn !== false;
    preferencesSuccess.hidden = true;
  }

  // Admin-only "Mode Admin" link (top of the page, see its own HTML comment)
  // -- no existing shared "is this user an admin" flag anywhere in
  // js/account.js/window.MonarkAccount, so this is its own fresh
  // profiles.select('is_admin') lookup, run whenever a real (non-guest)
  // session resolves. This is now the ONLY path from account.html to
  // admin.html -- the old ?redirect=admin.html auto-redirect
  // (maybeRedirectToAdmin(), which used to auto-continue back to admin.html
  // after login) was removed as redundant once this button existed; this
  // page now behaves identically regardless of query string. admin.html's
  // own js/admin.js still sends unauthenticated visitors to
  // account.html?redirect=admin.html (see that file's own redirectToLogin()
  // -- untouched, still needed to get an unauthenticated visitor OFF
  // admin.html somewhere), but that query param is simply ignored here now;
  // an admin who lands here that way just clicks this button manually.
  // Hidden first, THEN shown only once confirmed true -- never speculatively
  // visible while this is in flight, and a stale in-flight check from a
  // previous session can't leave it wrongly shown for a new one (each call
  // re-hides before re-checking).
  async function updateAdminModeButtonVisibility() {
    adminModeBtn.hidden = true;
    const userId = account.getCurrentUserId();
    if (!userId || !window.MonarkSupabase) return;
    const { data: profile, error } = await window.MonarkSupabase
      .from('profiles')
      .select('is_admin')
      .eq('id', userId)
      .maybeSingle();
    if (error || !profile || profile.is_admin !== true) return;
    adminModeBtn.hidden = false;
  }

  function showExtras(session) {
    // BUG FIX (mobile): resolving here (a real Log In or Create Account
    // submit, the common path onto this function) hides the auth step's
    // still-focused password field in the same synchronous tick as
    // unhiding every section below (order history, and for a real account
    // also Edit Profile/Saved Address/Saved Card/Preferences/Delete
    // Account) -- a big layout change landing at the exact same moment the
    // on-screen keyboard closes. Mobile Safari/Chrome don't always
    // recompute the page's scroll position cleanly when that happens (a
    // known class of bug: the viewport was scrolled up to keep the focused
    // field clear of the keyboard, and closing the keyboard while the
    // focused element itself disappears can leave that scroll uncorrected),
    // which is what left this page rendering with a blank gap above the
    // fixed header's own clearance instead of flush at the top like every
    // other page. Same fix, same reasoning as checkout.html's own
    // completeOrder() -- "swapping state doesn't itself move the viewport"
    // -- forcing it back to the top after the DOM change is what actually
    // corrects it, since nothing else here would.
    window.scrollTo(0, 0);
    orderHistory.hidden = false;

    if (session.isGuest) {
      guestOrderNote.hidden = false;
      orderHistoryContent.hidden = true;
      profileSection.hidden = true;
      addressSection.hidden = true;
      paymentSection.hidden = true;
      preferencesSection.hidden = true;
      dangerSection.hidden = true;
      adminModeBtn.hidden = true;
      return;
    }
    guestOrderNote.hidden = true;
    orderHistoryContent.hidden = false;
    renderOrders(session.email);
    renderProfile(session.email);
    resetDeleteConfirm();
    profileSection.hidden = false;
    addressSection.hidden = false;
    paymentSection.hidden = false;
    preferencesSection.hidden = false;
    dangerSection.hidden = false;
    updateAdminModeButtonVisibility();
  }

  function hideExtras() {
    orderHistory.hidden = true;
    profileSection.hidden = true;
    addressSection.hidden = true;
    paymentSection.hidden = true;
    preferencesSection.hidden = true;
    dangerSection.hidden = true;
    adminModeBtn.hidden = true;
    resetDeleteConfirm();
  }

  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const session = account.getSession();
    if (!session || session.isGuest) return;
    const email = profileEmailInput.value.trim();
    if (!email) {
      profileEmailError.textContent = t('accountGate.errorEmailEmpty');
      profileEmailError.hidden = false;
      return;
    }
    if (!isValidEmail(email)) {
      profileEmailError.textContent = t('accountGate.errorEmailInvalid');
      profileEmailError.hidden = false;
      return;
    }
    profileEmailError.hidden = true;

    const password = profilePasswordInput.value;
    if (password && !isValidPassword(password)) {
      profilePasswordError.textContent = t('accountGate.errorPasswordWeak');
      profilePasswordError.hidden = false;
      return;
    }
    profilePasswordError.hidden = true;

    // Neither field is required here (unlike checkout.html's Shipping form)
    // -- a profile with no name on file is valid, this only rejects a
    // NON-empty value that fails the shared format/length check
    // (window.MonarkValidateName, js/email-popup.js -- same one used by
    // checkout.html's Shipping form and the account-gate's Create Account
    // form, so a name is never accepted in one place and rejected in
    // another).
    const firstName = profileFirstNameInput.value.trim();
    if (firstName && window.MonarkValidateName && !window.MonarkValidateName(firstName)) {
      profileFirstNameError.textContent = t('common.errorNameFormat');
      profileFirstNameError.hidden = false;
      return;
    }
    profileFirstNameError.hidden = true;

    const lastName = profileLastNameInput.value.trim();
    if (lastName && window.MonarkValidateName && !window.MonarkValidateName(lastName)) {
      profileLastNameError.textContent = t('common.errorNameFormat');
      profileLastNameError.hidden = false;
      return;
    }
    profileLastNameError.hidden = true;

    const patch = {
      email,
      firstName,
      lastName,
      dob: profileDobInput.value
    };
    // Empty string, not omitted -- updateAccount() itself treats an empty
    // password as "don't change it" (see its own comment), so this is only
    // here to skip that check entirely when the field was left blank.
    if (password) patch.password = password;

    // Many fields on this form -- matches Place Order's own structure
    // (checkout.html's submitBtn) rather than disabling every field
    // individually: just the submit button, right before the async call.
    profileSubmitBtn.disabled = true;
    try {
      const result = await account.updateAccount(session.email, patch);
      if (!result.ok) {
        // BUG FIX: this used to show "account already exists" for every
        // failure reason, not just result.error === 'email-exists' -- so any
        // other updateAccount() failure (js/account.js's own console.error has
        // the real message) was misreported as an email collision. Same class
        // of bug as js/account.js's create-account handler had.
        profileEmailError.textContent = t(result.error === 'email-exists' ? 'accountGate.errorAccountExists' : 'accountGate.errorGeneric');
        profileEmailError.hidden = false;
        return;
      }
      profilePasswordInput.value = '';
      // A changed email needs to be confirmed via a link Supabase just sent to
      // the NEW address before it actually takes effect -- the session (and
      // this form's own email field, next time it's reloaded) still shows the
      // old one until then, so this tells the user what to expect instead of
      // implying the change already happened.
      profileSuccess.textContent = result.emailChangePending
        ? t('account.emailChangePending')
        : t('account.profileUpdated');
      profileSuccess.hidden = false;
    } finally {
      profileSubmitBtn.disabled = false;
    }
  });

  addressForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const session = account.getSession();
    if (!session || session.isGuest) return;

    // Neither field is required here (unlike checkout.html's Shipping form)
    // -- a profile with no saved address on file is valid, this only
    // rejects a NON-empty value that fails the shared format/length check
    // (window.MonarkValidateAddress/City, js/email-popup.js -- the same
    // ones checkout.html's Shipping form uses, so a value is never accepted
    // in one place and rejected in another).
    const addressVal = addressInput.value.trim();
    if (addressVal && window.MonarkValidateAddress && !window.MonarkValidateAddress(addressVal)) {
      addressFieldError.textContent = t('common.errorAddressFormat');
      addressFieldError.hidden = false;
      return;
    }
    addressFieldError.hidden = true;

    // Same "require an actual Places selection, with a manual-entry escape
    // hatch" nudge as checkout.html's own Shipping form -- see that page's
    // own validateShippingForm() comment for the full reasoning. Only
    // applies when there's a real value to check at all (addressVal, unlike
    // checkout.html this field is optional) and Places actually loaded for
    // this visitor (placesEnhanced).
    if (
      addressVal &&
      addressInput.dataset.placesEnhanced === 'true' &&
      addressInput.dataset.placesSelected !== 'true' &&
      !addressManualOverride
    ) {
      addressSelectNudge.hidden = false;
      addressInput.focus();
      return;
    }
    addressSelectNudge.hidden = true;

    const cityVal = cityInput.value.trim();
    if (cityVal && window.MonarkValidateCity && !window.MonarkValidateCity(cityVal)) {
      cityError.textContent = t('common.errorCityFormat');
      cityError.hidden = false;
      return;
    }
    cityError.hidden = true;

    const phoneValue = addressPhoneWidget ? addressPhoneWidget.getValue() : null;
    if (addressPhoneWidget && !addressPhoneWidget.isValid()) {
      addressPhoneError.textContent = t(phoneValue.country === 'FR' ? 'phoneInput.errorInvalidFR' : 'phoneInput.errorInvalidGeneric');
      addressPhoneError.hidden = false;
      return;
    }
    addressPhoneError.hidden = true;
    // Many fields on this form -- same "button only, matches Place Order's
    // own structure" choice as profileForm above.
    addressSubmitBtn.disabled = true;
    try {
      await account.updateAccount(session.email, {
        address: addressVal,
        extraDetails: extraDetailsInput.value.trim(),
        city: cityVal,
        postal: postalInput.value.trim(),
        phone: phoneValue ? phoneValue.number : '',
        dialCode: phoneValue ? phoneValue.dialCode : '',
        country: phoneValue ? phoneValue.country : ''
      });
      addressSuccess.textContent = t('account.addressUpdated');
      addressSuccess.hidden = false;
    } finally {
      addressSubmitBtn.disabled = false;
    }
  });

  // Purely mocked/cosmetic, same spirit as checkout.html's own disabled
  // Payment fields -- no real card data is ever validated, processed, or
  // transmitted anywhere (still true post-Supabase -- see js/account.js's
  // writeMockCard()/updateAccount() comments on why these stay
  // localStorage-only, there's no card table). CVC is deliberately not part
  // of this form at all (see the HTML comment on account-payment's markup).
  paymentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const session = account.getSession();
    if (!session || session.isGuest) return;

    // Not required (this whole feature is mocked/optional, see the note in
    // the form's own markup) -- only rejects a NON-empty value that fails
    // the same shared name-format check as first/last name (this field IS
    // a person's name, just printed on a card).
    const cardNameVal = cardNameInput.value.trim();
    if (cardNameVal && window.MonarkValidateCardName && !window.MonarkValidateCardName(cardNameVal)) {
      cardNameError.textContent = t('common.errorNameFormat');
      cardNameError.hidden = false;
      return;
    }
    cardNameError.hidden = true;

    // Same button-only treatment as profileForm/addressForm above, for
    // consistency across all four Save forms on this page.
    paymentSubmitBtn.disabled = true;
    try {
      await account.updateAccount(session.email, {
        cardName: cardNameVal,
        cardNumber: cardNumberInput.value.trim(),
        cardExpiry: cardExpiryInput.value.trim()
      });
      paymentSuccess.textContent = t('account.paymentUpdated');
      paymentSuccess.hidden = false;
    } finally {
      paymentSubmitBtn.disabled = false;
    }
  });

  // BUG FIX: used to save instantly on toggle, no separate submit button --
  // consistent with every other section here (Edit Profile, Address, Saved
  // Card) having its own explicit Save button now instead.
  preferencesForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const session = account.getSession();
    if (!session || session.isGuest) return;
    // Single field (the toggle) -- same disable-input-and-button pattern as
    // js/account.js's own email step, rather than the button-only treatment
    // the other three (multi-field) Save forms on this page use.
    preferencesSubmitBtn.disabled = true;
    marketingToggle.disabled = true;
    try {
      await account.updateAccount(session.email, { marketingOptIn: marketingToggle.checked });
      preferencesSuccess.textContent = t('account.preferencesUpdated');
      preferencesSuccess.hidden = false;
    } finally {
      preferencesSubmitBtn.disabled = false;
      marketingToggle.disabled = false;
    }
  });

  deleteBtn.addEventListener('click', () => { deleteConfirmBlock.hidden = false; });
  deleteCancelBtn.addEventListener('click', resetDeleteConfirm);
  deleteConfirmBtn.addEventListener('click', async () => {
    const session = account.getSession();
    if (!session || session.isGuest) return;
    // Only signs out + clears local state -- full deletion needs a
    // server-side Edge Function, see js/account.js's deleteAccount() comment
    // on why that can't safely happen from here.
    await account.deleteAccount(session.email);
    // deleteAccount() already calls logOut() internally (clears the session
    // + fires 'account:updated'), but the gate instance below only reacts to
    // 'monark:langchange' and its own 'account:updated' listener with a
    // fresh microtask -- calling gate.resolveSession() here too is what
    // flips its own UI back to the logged-out email-entry step immediately
    // rather than waiting on that.
    gate.resolveSession();
  });

  // Guest session's own "switch to account creation" shortcut -- logs the
  // guest out (a guest session is just an email attached to this browsing
  // session, not a real account, so there's nothing else to undo) and
  // re-resolves the gate back to its email-entry step, same
  // logOut()+resolveSession() pairing as the delete-account flow above.
  // Prefilling the email input and scrolling back up to the Account section
  // are pure convenience on top of that -- the guest still has to actually
  // submit the email and choose Log In or Create an Account, this just saves
  // them retyping the address they already gave once.
  guestCreateBtn.addEventListener('click', async () => {
    const session = account.getSession();
    if (!session || !session.isGuest) return;
    const guestEmail = session.email;
    await account.logOut();
    gate.resolveSession();
    const emailInput = document.getElementById('checkout-account-email-input');
    if (emailInput) emailInput.value = guestEmail;
    document.getElementById('account-step').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // statusLabel/changeLabel passed as functions, not plain strings -- see
  // js/account.js's mountAccountGate() comment on why (re-invoked fresh on
  // every 'monark:langchange' so a language switch updates them in place).
  const gate = window.MonarkAccount.mountAccountGate(document.getElementById('account-gate'), {
    statusLabel: (session) => session.isGuest
      ? t('account.statusGuest', { email: session.email })
      : t('accountGate.loggedInAs', { email: session.email }),
    changeLabel: () => t('account.logOut'),
    // This page is only for logging into or creating a real account -- a
    // guest session lands here from checkout.html's own guest flow, not
    // from a "Continue as Guest" choice made ON this page (see
    // guestCreateBtn's own shortcut above).
    hideGuestOption: true,
    onResolved: (session) => { showExtras(session); },
    onUnresolved: () => { hideExtras(); },
    // Bug fix: the gate can show its email/password step again (Modify
    // Email) WITHOUT the underlying Supabase session actually changing --
    // enterEmailEditMode() deliberately preserves it (see that function's
    // own comment), so resolveSession()'s dedup never re-fires onUnresolved
    // in that case, and adminModeBtn was staying visible (stale from the
    // previously-resolved state) while the login UI showed the email/
    // password fields underneath it. This fires on exactly that transition,
    // independent of the dedup, so the button disappears immediately;
    // updateAdminModeButtonVisibility() (called from showExtras() above)
    // is what brings it back once a session is genuinely resolved again.
    onEnterEditMode: () => { adminModeBtn.hidden = true; }
  });

  // MOBILE BUG FIX: "Modify Email" was overflowing off-screen on narrow
  // viewports once "Log Out" (changeBtn, only ever shown on this page --
  // see js/account.js's hideGuestOption handling) also shares the gate's own
  // status row with it. Standard UX convention for a less-frequent,
  // semi-destructive action is to demote it out of the primary info row
  // rather than crowd it there, so below 768px (same breakpoint as every
  // other mobile/desktop split in css/checkout.css) it moves to its own slot
  // at the bottom of the Account section instead, leaving Modify Email alone
  // in the row it was overflowing. Desktop has room for both -- nothing
  // moves there. Log Out is relocated as the SAME live DOM node (not
  // rebuilt), so its existing click handler/label just come along with it;
  // it's also already .checkout-account-link-btn styled, i.e. already reads
  // as the secondary/muted action this is meant to demote it to.
  const logoutSlot = document.getElementById('account-logout-slot');
  const logoutMobileQuery = window.matchMedia('(max-width: 768px)');
  function syncLogoutBtn() {
    const logoutBtn = document.getElementById('checkout-account-change-btn');
    const statusEl = document.getElementById('checkout-account-status');
    if (!logoutBtn || !statusEl) return;
    // Moved out of the gate's own hidden subtree (statusEl) once relocated,
    // so from here on its hidden state has to be kept in sync by hand --
    // it no longer inherits "hidden because its ancestor is" the way it does
    // while still inside statusEl.
    logoutBtn.hidden = statusEl.hidden;
    if (logoutMobileQuery.matches) {
      logoutSlot.appendChild(logoutBtn);
    } else {
      const actionsRow = statusEl.querySelector('.checkout-account-status-actions');
      if (actionsRow) actionsRow.prepend(logoutBtn);
    }
  }
  logoutMobileQuery.addEventListener('change', syncLogoutBtn);
  // Covers every later session change (js/account.js dispatches this on
  // each one) -- the very first resolveSession() call at mount, right
  // above, doesn't go through this event, hence the explicit call below.
  document.addEventListener('account:updated', syncLogoutBtn);
  syncLogoutBtn();
})();
