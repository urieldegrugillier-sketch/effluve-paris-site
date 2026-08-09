/* MONARK — reset-password.html's own dedicated script.
   Deliberately NOT window.MonarkAccount.mountAccountGate() -- that flow's
   whole purpose is resolving into a full account session (email/log-in/
   guest/create-account/order history/Edit Profile/etc.), and reusing it here
   would reintroduce exactly the surface area this page exists to eliminate.

   SECURITY CONTEXT (see js/account.js's AUTH_PASSWORD_RESET_REDIRECT_URL for
   the full writeup): a password-recovery link grants a real, persisted
   Supabase session -- not a special limited-purpose one. account.html/
   checkout.html's shared gate does correctly intercept that on first landing
   (isPasswordRecovery(), checked ahead of getSession()), but that flag is
   plain in-memory state that resets on any reload, while the underlying
   session survives via Supabase's own storage -- so a refresh before
   finishing the reset used to fall through to a normal resolved-session
   state and unlock full account access. This page closes that hole
   structurally: it has no OTHER content for any session state to unlock, on
   first load or any later refresh, so which way Supabase classifies the
   session no longer matters.
*/
(function () {
  const account = window.MonarkAccount;
  function t(key, vars) { return window.MonarkI18n ? window.MonarkI18n.t(key, vars) : key; }

  const formBlock = document.getElementById('reset-password-form-block');
  const invalidBlock = document.getElementById('reset-password-invalid');
  const successBlock = document.getElementById('reset-password-success');
  const form = document.getElementById('reset-password-form');
  const passwordInput = document.getElementById('reset-password-input');
  const requirementsList = document.getElementById('reset-password-requirements');
  const errorEl = document.getElementById('reset-password-error');
  const submitBtn = document.getElementById('reset-password-submit-btn');

  // Same floor as js/account.js's own mountAccountGate() create-account rule
  // (8+ characters, at least one letter, one number, and one special
  // character from !@#$%&*) -- duplicated here rather than exported from
  // account.js since it's also declared privately inside that file's own
  // mountAccountGate() closure, not part of its public API. Same approach
  // js/account-page.js's own Edit Profile password field already takes (see
  // that file's own comment) -- kept in sync by rule, not by import, so a
  // password accepted at signup/reset is never later rejected (or vice
  // versa) anywhere else on the site.
  const PASSWORD_SPECIAL_CHARS_RE = /[!@#$%&*]/;
  function isValidPassword(value) {
    return value.length >= 8 && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && PASSWORD_SPECIAL_CHARS_RE.test(value);
  }

  // Live requirements checklist -- same four checks/glyphs as the
  // create-account form's own updatePasswordRequirements() (js/account.js),
  // reimplemented here for the same "not part of the public API" reason as
  // isValidPassword() above.
  const PASSWORD_REQUIREMENT_CHECKS = {
    length: (value) => value.length >= 8,
    letter: (value) => /[A-Za-z]/.test(value),
    number: (value) => /[0-9]/.test(value),
    special: (value) => PASSWORD_SPECIAL_CHARS_RE.test(value)
  };
  function updatePasswordRequirements() {
    const value = passwordInput.value;
    Object.keys(PASSWORD_REQUIREMENT_CHECKS).forEach((key) => {
      const item = requirementsList.querySelector(`[data-requirement="${key}"]`);
      if (!item) return;
      const met = PASSWORD_REQUIREMENT_CHECKS[key](value);
      item.classList.toggle('password-requirement-met', met);
      const icon = item.querySelector('.password-requirement-icon');
      if (icon) icon.textContent = met ? '✓' : '○';
    });
  }
  passwordInput.addEventListener('input', updatePasswordRequirements);

  function showBlock(name) {
    formBlock.hidden = name !== 'form';
    invalidBlock.hidden = name !== 'invalid';
    successBlock.hidden = name !== 'success';
  }

  // Set the instant setNewPassword() succeeds -- render() below no-ops after
  // that, so the account:updated event setNewPassword() itself fires (via
  // notifySessionChange(), synchronously, before its own promise resolves)
  // can't flip the success screen back to the form in between.
  let succeeded = false;

  function render() {
    if (succeeded) return;
    const session = account.getSession();
    // A real (non-guest) session covers both the fresh recovery-link landing
    // (Supabase's PASSWORD_RECOVERY event, from the recovery token in the
    // URL) and a same-tab refresh before submitting, where that URL marker
    // and the in-memory isPasswordRecovery() flag are both already gone but
    // the session Supabase already established is still genuinely valid --
    // gating on the session itself, not the transient flag, is what keeps
    // this form working across a refresh instead of stranding the visitor on
    // "invalid link" for a session that's still perfectly good for setting a
    // new password. A guest session (just an email in localStorage, not a
    // real Supabase session) or no session at all still correctly falls
    // through to "invalid or expired".
    if (session && !session.isGuest) {
      showBlock('form');
    } else {
      showBlock('invalid');
    }
  }

  render();
  // Covers the async session hydration (see js/account.js's own file-level
  // comment: getSession()'s cache is briefly empty right after script
  // execution, until Supabase's INITIAL_SESSION/PASSWORD_RECOVERY event
  // resolves a tick later) -- the synchronous render() above can't see that
  // yet on a page that was never going to show a "logged out" flash either
  // way, so this is what upgrades "invalid" to "form" once it lands.
  document.addEventListener('account:updated', render);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = passwordInput.value;
    if (!isValidPassword(password)) {
      errorEl.textContent = t('accountGate.errorPasswordWeak');
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;
    submitBtn.disabled = true;
    try {
      const result = await account.setNewPassword(password);
      if (!result.ok) {
        errorEl.textContent = t('accountGate.errorGeneric');
        errorEl.hidden = false;
        return;
      }
      succeeded = true;
      showBlock('success');
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
