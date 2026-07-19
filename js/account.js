/* MONARK — mock account system (client-side only, localStorage-backed).
   PLACEHOLDER, same spirit as checkout.html's Payment section: this is a
   convincing-enough demo of "guest / log in / create account" to build the
   checkout flow against, not a real auth system. No backend, no password
   hashing/salting, no session tokens, no email verification -- passwords are
   stored in plaintext in localStorage. Replace entirely with real
   server-side accounts + auth before this ever ships.
   Exposes window.MonarkAccount. Every session change fires an
   'account:updated' event on document so any page's UI can react without
   polling, same pattern as js/cart.js's 'cart:updated'. */
(function (global) {
  const ACCOUNTS_KEY = 'monark_accounts';
  const SESSION_KEY = 'monark_session';

  function readAccounts() {
    try {
      const raw = localStorage.getItem(ACCOUNTS_KEY);
      const accounts = raw ? JSON.parse(raw) : [];
      return Array.isArray(accounts) ? accounts : [];
    } catch (e) {
      return [];
    }
  }

  function writeAccounts(accounts) {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
    return accounts;
  }

  function setSession(email) {
    if (email) {
      localStorage.setItem(SESSION_KEY, email);
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
    document.dispatchEvent(new CustomEvent('account:updated', { detail: { email: email || null } }));
  }

  function findAccount(email) {
    const needle = String(email || '').trim().toLowerCase();
    if (!needle) return undefined;
    return readAccounts().find((acc) => acc.email.toLowerCase() === needle);
  }

  function createAccount(email, password) {
    const cleanEmail = String(email || '').trim();
    if (findAccount(cleanEmail)) return { ok: false, error: 'exists' };
    const accounts = readAccounts();
    // PLACEHOLDER: plaintext password, stored as-is -- see the file-level
    // comment above. Fine for a mock with no backend to protect; not fine
    // the moment real accounts exist.
    accounts.push({ email: cleanEmail, password: String(password || '') });
    writeAccounts(accounts);
    setSession(cleanEmail);
    return { ok: true };
  }

  function logIn(email, password) {
    const account = findAccount(email);
    if (!account) return { ok: false, error: 'not-found' };
    if (account.password !== String(password || '')) return { ok: false, error: 'wrong-password' };
    setSession(account.email);
    return { ok: true };
  }

  // No account record is created -- a guest session is just an email
  // attached to this checkout, not a registered account.
  function continueAsGuest(email) {
    setSession(String(email || '').trim());
  }

  function logOut() {
    setSession(null);
  }

  function getSession() {
    const email = localStorage.getItem(SESSION_KEY);
    if (!email) return null;
    return { email, isGuest: !findAccount(email) };
  }

  /* ---------------- Shared account-gate UI ----------------
     The email -> guest/log-in/create-account flow was originally built as a
     one-off inline script in checkout.html. account.html needs the exact
     same flow (same steps, same validation, same markup/classes), and
     duplicating that script into a second file would mean every future fix
     has to be made twice and will eventually drift -- so it lives here
     instead, as the one shared implementation, and both pages just mount it
     into a container element with page-specific labels/callbacks.

     Deliberately still using the "checkout-account-*" id/class prefix on the
     injected markup below (rather than renaming everything to something more
     neutral) even though account.html now uses it too -- same precedent as
     body.shop-page ending up on non-shop pages (mentions-legales.html,
     404.html, etc.): reusing the existing, already-styled names keeps this a
     pure extraction with no accompanying rename, rather than a rename PLUS
     an extraction bundled into one change. The corresponding CSS lives in
     css/cart.css under "account step", loaded by both pages. */
  // Static labels below carry data-i18n tags -- window.MonarkI18n.apply() is
  // called on this markup right after it's mounted (see mountAccountGate())
  // for the first render, and a later language switch's own global
  // apply(document) pass re-walks it automatically since it's part of
  // `document` by then. Only the *dynamic*, multi-condition error messages
  // (email/login/create-account errors, each with 2-3 possible texts
  // depending on which validation failed) are NOT tagged this way -- those
  // are set via MonarkI18n.t() fresh at the moment they're shown instead,
  // same pattern as js/email-popup.js's own per-condition error messages.
  function accountGateMarkup() {
    return `
      <p class="checkout-account-status" id="checkout-account-status" hidden>
        <span id="checkout-account-status-text"></span>
        <button type="button" class="checkout-account-link-btn" id="checkout-account-change-btn"></button>
      </p>

      <form id="checkout-account-email-form" novalidate>
        <p class="checkout-account-intro" data-i18n="accountGate.intro">Please enter your email to continue as a guest, log in, or create an account.</p>
        <label class="checkout-field">
          <span data-i18n="accountGate.emailLabel">Email</span>
          <input type="email" id="checkout-account-email-input" autocomplete="email" required>
        </label>
        <p class="promo-message promo-message-error" id="checkout-account-email-error" aria-live="polite" hidden></p>
        <button type="submit" class="cta-button checkout-account-btn-sm" data-i18n="accountGate.continueBtn">Continue</button>
      </form>

      <form id="checkout-account-login-form" hidden>
        <p class="checkout-account-email-echo" id="checkout-account-login-email"></p>
        <label class="checkout-field">
          <span data-i18n="accountGate.passwordLabel">Password</span>
          <input type="password" id="checkout-account-login-password" autocomplete="current-password" required>
        </label>
        <p class="promo-message promo-message-error" id="checkout-account-login-error" aria-live="polite" hidden></p>
        <button type="submit" class="cta-button checkout-account-btn-sm" data-i18n="accountGate.logInBtn">Log In</button>
      </form>

      <div id="checkout-account-new" hidden>
        <p class="checkout-account-email-echo" id="checkout-account-new-email"></p>
        <div class="checkout-account-options">
          <button type="button" class="cta-button checkout-account-btn-sm" id="checkout-account-guest-btn" data-i18n="accountGate.continueAsGuest">Continue as Guest</button>
          <button type="button" class="checkout-account-link-btn" id="checkout-account-create-toggle" data-i18n="accountGate.createAccountInstead">Create an account instead</button>
        </div>

        <form id="checkout-account-create-form" class="checkout-account-create-form" hidden>
          <label class="checkout-field">
            <span data-i18n="accountGate.passwordLabel">Password</span>
            <input type="password" id="checkout-account-create-password" autocomplete="new-password" required>
          </label>
          <label class="checkout-field">
            <span data-i18n="accountGate.confirmPasswordLabel">Confirm Password</span>
            <input type="password" id="checkout-account-create-confirm" autocomplete="new-password" required>
          </label>
          <p class="promo-message promo-message-error" id="checkout-account-create-error" aria-live="polite" hidden></p>
          <button type="submit" class="cta-button checkout-account-btn-sm" data-i18n="accountGate.createAccountAndContinue">Create Account &amp; Continue</button>
        </form>
      </div>
    `;
  }

  /* Mounts the gate into `container` (its innerHTML is fully replaced --
     pass a dedicated empty element, not one that also holds a page heading
     or anything else worth keeping) and wires up every step. `options`:
       - statusLabel(session) -> string shown once resolved (defaults to
         checkout.html's original "Checking out as X (Guest)" / "Logged in
         as X" wording)
       - changeLabel: text for the button that logs out and re-shows the
         email step (checkout.html: "Modify"; account.html: "Log Out")
       - onResolved(session): called once a session exists (on mount, and
         after every successful log-in/guest/create-account)
       - onUnresolved(): called whenever there's no session (on mount, and
         after changeLabel's button is clicked)
     Returns { resolveSession } in case the host page ever needs to force a
     re-check (not currently used by either page, but costs nothing to
     expose rather than trapping it in the closure). */
  function t(key, vars) { return global.MonarkI18n ? global.MonarkI18n.t(key, vars) : key; }

  function mountAccountGate(container, options) {
    if (!container) return null;
    options = options || {};
    // Both are functions (checkout.html/account.html pass them as such, each
    // calling MonarkI18n.t() with its own page-specific keys) so they can be
    // re-invoked fresh on every language switch, not just once at mount time
    // -- a plain string/closure captured once wouldn't pick up a later
    // 'monark:langchange'. The fallbacks here cover any future caller that
    // doesn't pass one.
    const changeLabel = typeof options.changeLabel === 'function' ? options.changeLabel : () => options.changeLabel || t('accountGate.modify');
    const statusLabel = options.statusLabel || function (session) {
      return session.isGuest
        ? t('accountGate.guestDefault', { email: session.email })
        : t('accountGate.loggedInAs', { email: session.email });
    };

    container.innerHTML = accountGateMarkup();
    if (global.MonarkI18n) global.MonarkI18n.apply(container);

    const statusEl = container.querySelector('#checkout-account-status');
    const statusText = container.querySelector('#checkout-account-status-text');
    const changeBtn = container.querySelector('#checkout-account-change-btn');
    changeBtn.textContent = changeLabel();

    const emailForm = container.querySelector('#checkout-account-email-form');
    const emailInput = container.querySelector('#checkout-account-email-input');
    const emailError = container.querySelector('#checkout-account-email-error');

    const loginForm = container.querySelector('#checkout-account-login-form');
    const loginEmailEcho = container.querySelector('#checkout-account-login-email');
    const loginPasswordInput = container.querySelector('#checkout-account-login-password');
    const loginError = container.querySelector('#checkout-account-login-error');

    const newAccountBlock = container.querySelector('#checkout-account-new');
    const newEmailEcho = container.querySelector('#checkout-account-new-email');
    const guestBtn = container.querySelector('#checkout-account-guest-btn');
    const createToggle = container.querySelector('#checkout-account-create-toggle');

    const createForm = container.querySelector('#checkout-account-create-form');
    const createPasswordInput = container.querySelector('#checkout-account-create-password');
    const createConfirmInput = container.querySelector('#checkout-account-create-confirm');
    const createError = container.querySelector('#checkout-account-create-error');

    // Takes an i18n key (not raw text) -- each of these fields can show one
    // of 2-3 different messages depending on which validation failed, so
    // (unlike accountGateMarkup()'s single-message static fields above)
    // there's no one fixed data-i18n tag to put on the element; resolving
    // the key fresh here means the message is correct for whatever language
    // is active at the moment it's shown, same as js/email-popup.js's own
    // per-condition error messages.
    function showFieldError(el, key) {
      el.textContent = t(key);
      el.hidden = false;
    }

    // Not a full RFC 5322 validator -- just enough to catch an obviously
    // incomplete address (no "@", no domain) before it reaches
    // findAccount()/createAccount().
    function isPlausibleEmail(value) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    }

    // 8+ characters, at least one letter and one number -- a floor, not a
    // real strength policy (no symbol requirement, no breach-list check).
    // Good enough for a mock with no real accounts behind it yet.
    function isValidPassword(value) {
      return value.length >= 8 && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
    }

    // Hides every sub-step of the gate, then reveals only the one asked for
    // (or none, once a session exists) -- avoids repeating the same
    // three-way "hide everything else" in each handler below. Also collapses
    // the create-account form back shut whenever we leave the "new email"
    // step entirely, so it doesn't stay open if the user comes back through.
    function showStep(step) {
      emailForm.hidden = step !== 'email';
      loginForm.hidden = step !== 'login';
      newAccountBlock.hidden = step !== 'new';
      if (step !== 'new') createForm.hidden = true;
    }

    function resolveSession() {
      const session = getSession();
      if (!session) {
        statusEl.hidden = true;
        showStep('email');
        emailInput.value = '';
        emailError.hidden = true;
        if (options.onUnresolved) options.onUnresolved();
        return;
      }
      statusText.textContent = statusLabel(session);
      statusEl.hidden = false;
      showStep(null);
      if (options.onResolved) options.onResolved(session);
    }

    emailForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = emailInput.value.trim();
      if (!email) {
        showFieldError(emailError, 'accountGate.errorEmailEmpty');
        return;
      }
      if (!isPlausibleEmail(email)) {
        showFieldError(emailError, 'accountGate.errorEmailInvalid');
        return;
      }
      emailError.hidden = true;
      if (findAccount(email)) {
        loginEmailEcho.textContent = email;
        loginPasswordInput.value = '';
        loginError.hidden = true;
        showStep('login');
        loginPasswordInput.focus();
      } else {
        newEmailEcho.textContent = email;
        createPasswordInput.value = '';
        createConfirmInput.value = '';
        createError.hidden = true;
        showStep('new');
      }
    });

    loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const result = logIn(loginEmailEcho.textContent, loginPasswordInput.value);
      if (result.ok) {
        resolveSession();
      } else {
        showFieldError(loginError, result.error === 'wrong-password' ? 'accountGate.errorWrongPassword' : 'accountGate.errorAccountNotFound');
      }
    });

    guestBtn.addEventListener('click', () => {
      continueAsGuest(newEmailEcho.textContent);
      resolveSession();
    });

    createToggle.addEventListener('click', () => {
      createForm.hidden = !createForm.hidden;
      if (!createForm.hidden) createPasswordInput.focus();
    });

    createForm.addEventListener('submit', (e) => {
      e.preventDefault();
      // Checked in sequence, each with its own early return, so a password
      // that's both too weak AND mismatched doesn't have one problem
      // silently mask the other -- the user always sees whichever is wrong
      // first, and fixing it surfaces the next one rather than both failing
      // invisibly.
      if (!isValidPassword(createPasswordInput.value)) {
        showFieldError(createError, 'accountGate.errorPasswordWeak');
        return;
      }
      if (createPasswordInput.value !== createConfirmInput.value) {
        showFieldError(createError, 'accountGate.errorPasswordMismatch');
        return;
      }
      createError.hidden = true;
      const result = createAccount(newEmailEcho.textContent, createPasswordInput.value);
      if (result.ok) {
        resolveSession();
      } else {
        showFieldError(createError, 'accountGate.errorAccountExists');
      }
    });

    changeBtn.addEventListener('click', () => {
      logOut();
      resolveSession();
    });

    // changeBtn's label and (if a session is already showing) statusText's
    // label are both set from plain textContent writes above, not
    // data-i18n-tagged elements -- MonarkI18n.apply(document)'s own
    // langchange-triggered pass has nothing to re-walk for either, so this
    // is the only thing that keeps them correct after a language switch.
    document.addEventListener('monark:langchange', () => {
      changeBtn.textContent = changeLabel();
      const session = getSession();
      if (session) statusText.textContent = statusLabel(session);
    });

    resolveSession();

    return { resolveSession };
  }

  global.MonarkAccount = {
    findAccount,
    createAccount,
    logIn,
    continueAsGuest,
    logOut,
    getSession,
    mountAccountGate
  };
})(window);
