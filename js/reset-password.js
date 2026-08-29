/* MONARK — reset-password.html's own dedicated script.
   Deliberately NOT window.MonarkAccount.mountAccountGate() -- that flow's
   whole purpose is resolving into a full account session (email/log-in/
   guest/create-account/order history/Edit Profile/etc.), and reusing it here
   would reintroduce exactly the surface area this page exists to eliminate.

   ARCHITECTURE (revised -- this page used to have its own full "set new
   password" form; it no longer does): the previous design had TWO
   independent, fully-working forms that could both act on the same recovery
   session -- this page's own, and a "legacy fallback" one embedded in
   account.html/checkout.html's shared gate. A real security bug came from
   that duplication, not from either form's own validation: supabase-js
   broadcasts every auth event (including PASSWORD_RECOVERY) to every
   same-origin tab via its own BroadcastChannel, by default -- confirmed
   live, no extra wiring needed. That's exactly what already let a customer
   who finished a reset on THIS page find their original checkout.html/
   account.html tab quietly resolved to logged-in (see js/account.js's own
   USER_UPDATED handling) -- but it turns out to ALSO relay the recovery
   session itself the moment the email link is clicked, before any password
   is ever set. The original tab's OWN recovery form could act on that
   broadcasted session directly, with no token of its own ever verified
   there. The broadcast itself isn't the bug (it's real, Supabase-verified
   state, not something forged by clicking "Forgot password" alone --
   confirmed separately that on its own changes nothing); having two
   separate, independently-reachable forms wired to accept it was.

   Fixed by removing this page's own form entirely rather than hardening it
   further: the ONE actual "set new password" form now lives only in
   js/account.js's mountAccountGate() (the #checkout-account-recovery step),
   reached only via that same cross-tab broadcast -- now the single,
   deliberate path instead of a second, accidental one. This page's only
   remaining job is confirming the link was valid and pointing the customer
   back to whichever tab they started from. */
(function () {
  const account = window.MonarkAccount;
  function t(key, vars) { return window.MonarkI18n ? window.MonarkI18n.t(key, vars) : key; }

  const returnBlock = document.getElementById('reset-password-return-block');
  const invalidBlock = document.getElementById('reset-password-invalid');
  const emailLine = document.getElementById('reset-password-email-line');

  // Same split-on-{placeholder} + real <strong> element approach as
  // js/checkout-page.js's own setLineWithBoldValue() -- see that file's
  // comment for why this is never done via innerHTML/data-i18n-html: the
  // email is session-supplied, not this project's own authored copy.
  function setLineWithBoldValue(el, key, varName, value) {
    const template = t(key);
    const placeholder = `{${varName}}`;
    const idx = template.indexOf(placeholder);
    el.textContent = '';
    if (idx === -1) {
      el.textContent = template;
      return;
    }
    const strong = document.createElement('strong');
    strong.textContent = value;
    el.append(
      document.createTextNode(template.slice(0, idx)),
      strong,
      document.createTextNode(template.slice(idx + placeholder.length))
    );
  }

  function showBlock(name) {
    returnBlock.hidden = name !== 'return';
    invalidBlock.hidden = name !== 'invalid';
  }

  function render() {
    const session = account.getSession();
    // A real (non-guest) session covers both the fresh recovery-link landing
    // and a same-tab refresh -- gating on the session itself, not the
    // transient isPasswordRecovery() flag, is what keeps this page working
    // across a refresh instead of stranding the visitor on "invalid link"
    // for a session that's still perfectly good. A guest session (just an
    // email in localStorage, not a real Supabase session) or no session at
    // all still correctly falls through to "invalid or expired".
    if (session && !session.isGuest) {
      setLineWithBoldValue(emailLine, 'resetPassword.forEmail', 'email', session.email);
      showBlock('return');
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
  // way, so this is what upgrades "invalid" to "return" once it lands.
  document.addEventListener('account:updated', render);
})();
