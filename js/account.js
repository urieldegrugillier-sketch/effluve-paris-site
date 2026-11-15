/* MONARK — account system, backed by Supabase Auth + public.profiles/orders.
   Exposes window.MonarkAccount. Every session change fires an
   'account:updated' event on document so any page's UI can react without
   polling, same pattern as js/cart.js's 'cart:updated'.

   Requires js/supabase-client.js (window.MonarkSupabase) loaded first -- see
   that file for the CDN script tag + placeholder project URL/key it needs.

   ASYNC NOTE: unlike the old localStorage mock, every call that touches
   Supabase (createAccount/logIn/logOut/updateAccount/deleteAccount/
   findAccount/getOrders/recordOrder/requestPasswordReset/setNewPassword) is
   now a real network round trip and returns a Promise. getSession() is the
   one exception -- it stays synchronous, backed by an in-memory session
   cache kept current by supabase.auth.onAuthStateChange() below, so every
   *existing* synchronous `getSession()` call site (checkout.html's submit
   handler, account.html's form handlers) keeps working unchanged. The one
   unavoidable side effect: on first page load, that cache is still empty
   for the instant between script execution and Supabase's own
   INITIAL_SESSION auth event resolving (a browser tick later), so a
   returning logged-in visitor briefly sees the "enter your email" step
   before it flips to "Logged in as X" -- there is no synchronous way to
   avoid that with a real backend. mountAccountGate() below listens for
   'account:updated' precisely to catch that flip (and any other
   out-of-band session change, e.g. another tab logging out) without every
   caller having to know about it. */
(function (global) {
  // Off until the Meta app backing signInWithFacebook() below finishes
  // Meta's business verification -- until then Facebook rejects the login
  // for anyone outside the app's own test-user list, so the button is
  // hidden rather than shown and failing for every real visitor. Flip this
  // back to true (no other change needed) once verification is done --
  // signInWithFacebook(), its i18n keys, and all of its error handling stay
  // in place below either way.
  const FACEBOOK_LOGIN_ENABLED = false;

  function client() { return global.MonarkSupabase; }

  const GUEST_KEY = 'monark_guest_email';
  const MOCK_CARD_KEY_PREFIX = 'monark_mock_card_';
  // Holds the email a brand-new signUp() is awaiting its 6-digit
  // verifyOtp() confirmation for -- set the instant createForm's own submit
  // handler below sends that email its first code, read back on a fresh
  // page load so a reload mid-verification returns straight to the code
  // step instead of a blank email form (see mountAccountGate()'s own
  // pendingCodeEmail). Deliberately holds ONLY the email, never the
  // password -- verifyOtp() only ever needs the email plus the typed code,
  // so there's nothing else this flow could leak by persisting it.
  // sessionStorage (not localStorage): scoped to this one tab/visit, same
  // reasoning as every other short-lived marker in this file.
  const SIGNUP_OTP_PENDING_EMAIL_KEY = 'monark_signup_otp_pending_email';
  // How many of the 3 allowed verifyOtp() attempts have already failed for
  // the currently pending code (see MAX_CODE_ATTEMPTS below) -- sessionStorage
  // alongside SIGNUP_OTP_PENDING_EMAIL_KEY, for the same reason: a reload
  // mid-verification must not hand back 3 fresh attempts for free.
  const SIGNUP_OTP_ATTEMPTS_KEY = 'monark_signup_otp_attempts';
  // When the currently pending code was actually sent (Date.now(), as a
  // string) -- the 60-second resend cooldown is computed FROM this on every
  // render (see computeResendRemaining()) rather than counted down from a
  // fixed 60 in memory, so a reload mid-cooldown shows the real remaining
  // time instead of resetting it to a fresh 60s.
  const SIGNUP_OTP_SENT_AT_KEY = 'monark_signup_otp_sent_at';
  // Supabase refuses a second email to the same address before 60 seconds
  // (confirmed live -- a 30s cooldown on this UI used to let a customer hit
  // "Resend" before Supabase's own window actually cleared, which just
  // bounced back as a rate-limit error). One constant, read everywhere this
  // UI shows or counts down a resend wait, so there's never a second value
  // to drift out of sync with it.
  const RESEND_COOLDOWN_SECONDS = 60;
  // Supabase's own rate-limit error messages usually embed the real wait
  // ("For security purposes, you can only request this after 48 seconds.")
  // -- read straight from there wherever available, so a resend countdown
  // reflects the real remaining time instead of always restarting the full
  // RESEND_COOLDOWN_SECONDS even moments before Supabase would have allowed
  // it anyway. Null when no number is present in the message at all (e.g.
  // the hourly-quota rejection, which gives no specific wait at all).
  function parseRetrySeconds(message) {
    const match = /(\d+)\s*second/i.exec(String(message || ''));
    return match ? parseInt(match[1], 10) : null;
  }
  // Supabase's email-sending throttle comes in two different shapes: a
  // short, per-address cooldown that names its own exact wait (handled via
  // parseRetrySeconds() above), and the project's blunter hourly quota,
  // which gives no number at all -- "too many attempts" is actively
  // misleading for that second case (nothing was attempted wrong, the
  // project just mailed too much this hour), so it gets its own distinct
  // copy instead. Takes the raw {error, retryAfterSeconds} result shape
  // createAccount()/resendSignupOtp() both return on 'rate-limited'.
  function rateLimitMessageKey(result) {
    return result.retryAfterSeconds ? 'accountGate.errorRateLimited' : 'accountGate.errorEmailRateLimited';
  }
  // Matches this project's Supabase dashboard config (email OTP expiration,
  // 600 seconds) -- the one authoritative threshold for "is this code
  // actually expired yet", used two places: deciding whether a fresh
  // SIGNUP_OTP_SENT_AT_KEY is still restorable at all on a reload/
  // back-forward navigation (see pendingSignupEmailIsRestorable()), and
  // reclassifying Supabase's own ambiguous "invalid or expired" verifyOtp()
  // error (see codeForm's own submit handler further down -- BUG FIX 3).
  const OTP_EXPIRY_MS = 600000;
  // Written right before every signInWithOAuth() redirect (Google or
  // Facebook, see signInWithGoogle()/signInWithFacebook() below) so that once
  // the provider/Supabase redirect back lands on a FRESH page load,
  // mountAccountGate() can tell which of the two buttons' own error paragraph
  // an `error` URL param (consumeOAuthErrorFromUrl()) belongs to -- that URL
  // param alone carries no provider info. sessionStorage (not localStorage):
  // only needs to survive this one same-tab redirect round trip, same scope
  // reasoning as every other short-lived marker in this file.
  const OAUTH_PROVIDER_PENDING_KEY = 'monark_oauth_provider_pending';
  // REVISED (recovery-pending state used to survive a refresh via
  // sessionStorage -- it no longer does, at all, see passwordRecoveryActive's
  // own comment below for why). RECOVERY_UNCONFIRMED_KEY is the one thing
  // that still persists, and it's deliberately NOT the same thing: it never
  // drives the recovery form (isPasswordRecovery() below never reads it --
  // that's now purely in-memory), it only exists so a FRESH page load (a
  // refresh, a new tab, or this same tab navigating elsewhere) can tell
  // "was there an unconfirmed recovery session left behind" and sign out of
  // it silently, rather than ever risk exposing it as a normal logged-in
  // session -- see onAuthStateChange's own INITIAL_SESSION handling below
  // for exactly where that happens. localStorage (not sessionStorage): the
  // whole point is to be visible to ANY tab/page/reload, not just the one
  // that set it. No email/timestamp alongside it any more (see this file's
  // own git history for the previous, more elaborate version) -- nothing
  // downstream needs either any more, see setRecoveryPending()'s own comment.
  const RECOVERY_UNCONFIRMED_KEY = 'monark_recovery_unconfirmed';

  // The real production domain (matches README.md's own
  // "https://effluve-paris.fr" note -- canonical links, robots.txt,
  // sitemap.xml) -- Supabase redirects the user here after they click the
  // signup-confirmation link in their email. Landing on account.html is
  // correct for THIS flow: confirming a brand-new account is exactly what
  // should drop the visitor into their own (now-verified) account.
  //
  // NOTE: passing this explicitly here is necessary but NOT sufficient on
  // its own -- Supabase Auth also enforces its own server-side allow-list
  // (Dashboard -> Authentication -> URL Configuration -> "Redirect URLs").
  // If this exact URL isn't on that list, Supabase silently ignores it and
  // falls back to the project's configured Site URL instead -- which is
  // almost certainly the actual cause if these links are still landing on
  // localhost despite this constant already being correct: that's a
  // dashboard configuration gap, not something fixable from this file. See
  // this project's own session notes on the localhost-redirect
  // investigation for the exact dashboard fields to check.
  const AUTH_EMAIL_REDIRECT_URL = 'https://effluve-paris.fr/account.html';

  // ARCHITECTURE (revised -- flow direction inverted from the original
  // design, after a real security bug surfaced in that one): every
  // password-reset email link still points here, but reset-password.html no
  // longer contains a working "set new password" form at all -- it only
  // confirms the link was valid and tells the customer to go back to
  // whichever tab they started the request from (see js/reset-password.js's
  // own header comment). The actual form now lives in THIS file's own
  // mountAccountGate() recovery step, on account.html/checkout.html --
  // reached not by the customer clicking anything there, but by that tab
  // picking up the SAME PASSWORD_RECOVERY session reset-password.html's tab
  // just established, via supabase-js's own cross-tab BroadcastChannel sync
  // (onAuthStateChange below receives it exactly like a same-tab event --
  // confirmed live, no extra wiring needed; see updateUserLocally()'s own
  // comment for the same mechanism already relied on for USER_UPDATED).
  //
  // WHY THIS CHANGED: the original design had reset-password.html show its
  // OWN full working form (the "structural" fix for a real refresh-based
  // access hole, see git history) while mountAccountGate() ALSO kept a
  // second, separate recovery form as a declared "legacy fallback" for old
  // links. Once the cross-tab broadcast above existed (built for a
  // different, legitimate reason -- syncing an ALREADY-COMPLETED reset back
  // to an open original tab), it turned out to ALSO relay the recovery
  // session itself to account.html/checkout.html the moment the customer
  // clicked the email link in any tab -- which the "legacy fallback" form
  // was fully able to act on. Confirmed live: a tab sitting on checkout.html
  // that never processed any token itself still received a working
  // recovery session purely from another tab's broadcast, and its own
  // (unhardened-for-this) recovery form would have let it complete the
  // reset from there. Two independent, simultaneously-live forms reachable
  // from the exact same broadcasted session was the actual bug -- not the
  // broadcast itself, which is real, Supabase-verified state, not something
  // forged by clicking "Forgot password" alone (confirmed separately: that
  // click alone, with no token ever verified anywhere, changes nothing).
  // Removing the duplicate and making the broadcast-driven path the ONE,
  // deliberate, hardened way to reach this form closes that rather than
  // patching around it a second time.
  //
  // REVISED AGAIN: that broadcast-driven form used to also gate itself
  // across a refresh via sessionStorage (RECOVERY_PENDING_KEY), so
  // refreshing mid-recovery, or navigating to a different page in the same
  // tab, kept showing the recovery form there too -- including on a
  // completely unrelated page the customer never asked to see it on. Now it
  // doesn't: passwordRecoveryActive below is purely in-memory, so the
  // recovery form only ever appears as a direct, live reaction to actually
  // receiving a PASSWORD_RECOVERY broadcast while a page is already open and
  // running, never reconstructed from anything stored. A refresh or
  // navigation while still mid-recovery is instead treated exactly like
  // clicking the form's own Cancel button -- see the pagehide listener and
  // RECOVERY_UNCONFIRMED_KEY's own comments just below for the two
  // complementary mechanisms that make that hold even when the customer
  // never clicks Cancel themselves.
  const AUTH_PASSWORD_RESET_REDIRECT_URL = 'https://effluve-paris.fr/reset-password.html';

  let currentAuthUser = null; // { id, email } | null -- kept in sync below
  let currentProfile = null; // last-fetched public.profiles row for currentAuthUser, cleared on any auth change
  // True between a PASSWORD_RECOVERY auth event and a successful
  // setNewPassword() (or an explicit Cancel/logOut()) -- deliberately PURE
  // in-memory now, not backed by sessionStorage at all: a refresh or
  // navigation should never be able to reconstruct the recovery form, only
  // a live broadcast received while this exact page is already running
  // should (see AUTH_PASSWORD_RESET_REDIRECT_URL's own comment above for
  // the full reasoning). isPasswordRecovery() below reads ONLY this.
  let passwordRecoveryActive = false;
  // The email the pending recovery is FOR -- same in-memory-only scope as
  // passwordRecoveryActive, kept for the exact same reason it always was:
  // letting onAuthStateChange's SIGNED_IN branch tell a genuine new login
  // (a DIFFERENT account, which should win over a stale recovery) apart
  // from supabase-js's own internal re-notification of the SAME recovery
  // session, which real Chrome testing confirmed DOES happen live, with no
  // refresh involved at all: switching back to this tab fires a real
  // visibilitychange, which supabase-js's _onVisibilityChanged() ->
  // _recoverAndRefresh() (confirmed via its own source) answers by
  // unconditionally re-firing SIGNED_IN for whatever valid session is
  // already in shared storage. Still relevant here regardless of today's
  // refresh/navigation changes, since this specific case never involved a
  // refresh to begin with.
  let recoveryPendingEmail = null;

  // The only place passwordRecoveryActive/recoveryPendingEmail (in-memory,
  // this page's own lifetime only) OR RECOVERY_UNCONFIRMED_KEY (localStorage,
  // survives everything -- see its own comment above) ever get written --
  // keeps all three in sync so nothing can set one without the others and
  // drift out of agreement. email is only meaningful when pending is true.
  function setRecoveryPending(pending, email) {
    passwordRecoveryActive = pending;
    recoveryPendingEmail = pending ? (email || null) : null;
    if (pending) {
      localStorage.setItem(RECOVERY_UNCONFIRMED_KEY, '1');
    } else {
      localStorage.removeItem(RECOVERY_UNCONFIRMED_KEY);
    }
  }

  // Purely in-memory now -- see passwordRecoveryActive's own comment for why
  // this deliberately never reads any persisted storage.
  function getRecoveryPendingEmail() {
    return recoveryPendingEmail;
  }

  // Set for the duration of any auth.updateUser() call made BY THIS TAB
  // (password/email change, the language-metadata sync below) so
  // onAuthStateChange's USER_UPDATED branch can tell that apart from a
  // USER_UPDATED event arriving from elsewhere -- supabase-js broadcasts
  // every auth state change to every same-origin tab via a BroadcastChannel
  // keyed off the project's own storageKey (confirmed live: posting on one
  // tab's client().auth.broadcastChannel is received by another tab's
  // onAuthStateChange with zero extra wiring), which is exactly what lets a
  // customer who finishes reset-password.html in one tab come back to an
  // already-open account.html/checkout.html tab and find it quietly
  // resolved to logged-in instead of still showing the login form -- see
  // updateUserLocally() below and the USER_UPDATED branch a few lines down.
  let localAuthChangeInFlight = false;

  // Every LOCAL call to auth.updateUser() should go through this instead of
  // calling client().auth.updateUser() directly -- see
  // localAuthChangeInFlight's own comment above for why.
  async function updateUserLocally(patch) {
    localAuthChangeInFlight = true;
    try {
      return await client().auth.updateUser(patch);
    } finally {
      localAuthChangeInFlight = false;
    }
  }

  function notifySessionChange() {
    const session = getSession();
    document.dispatchEvent(new CustomEvent('account:updated', { detail: { email: session ? session.email : null } }));
  }

  // Guards the one call in this file made outside any function, at module
  // load time -- if the CDN script failed to load or js/supabase-client.js
  // bailed out (see that file's own guard), client() is undefined here, and
  // an unguarded client().auth.onAuthStateChange() would throw synchronously
  // and abort this whole IIFE, leaving window.MonarkAccount undefined and
  // taking every page's checkout/account UI down with it. Every OTHER use of
  // client() in this file is safe without an extra check: they all live
  // inside `async function`s, where a synchronous throw just rejects that
  // call's own Promise instead of crashing the script.
  if (client() && client().auth) {
    // Fires on load (Supabase reports any persisted session as an
    // INITIAL_SESSION event here -- see the file-level comment above on why
    // that's asynchronous) and again on every sign-in/sign-out/token-refresh/
    // password-recovery. This is the single source of truth currentAuthUser
    // is ever written from.
    client().auth.onAuthStateChange((event, session) => {
      // Backstop against a lingering, never-confirmed recovery session
      // surviving into a fresh page load -- a refresh, a brand-new tab, or
      // this same tab navigating to a different page. passwordRecoveryActive
      // itself is pure in-memory now (see its own comment) and a page's
      // pagehide listener below already tries to sign out proactively before
      // that happens, but pagehide-triggered signOut() is best-effort only:
      // supabase-js's own _signOut() awaits the server-side revocation
      // BEFORE clearing the local session (confirmed by reading its source),
      // and browsers don't guarantee an in-flight request survives the page
      // actually unloading -- so the session can still be sitting in
      // localStorage, untouched, by the time a fresh page loads. THIS check
      // is what actually guarantees correctness: INITIAL_SESSION is the one
      // event that only ever reports "whatever was already in storage when
      // this page loaded" (confirmed empirically: a pre-seeded session fires
      // exactly one INITIAL_SESSION event and nothing else) -- never
      // anything live/active, so gating on it specifically means this can
      // never fire for the legitimate cases (a real PASSWORD_RECOVERY
      // broadcast, a real SIGNED_IN, setNewPassword()'s own USER_UPDATED).
      // Returning before currentAuthUser is ever touched for THIS event
      // means the session can't flash into "logged in" even for a moment;
      // the resulting SIGNED_OUT event once the revocation completes is what
      // actually updates currentAuthUser/the UI, through the exact same path
      // a real sign-out always takes.
      //
      // Calls client().auth.signOut() directly here, NOT the logOut()
      // wrapper -- logOut() early-returns without calling signOut() at all
      // when currentAuthUser is already null (a real optimization for its
      // OTHER callers, e.g. account-page.js's guestLoginBtn logging out of a
      // guest session that was never really logged in server-side to begin
      // with) -- which is EXACTLY the state currentAuthUser is deliberately
      // still in here, on this very first event of a fresh page load. That
      // guard would silently skip the real signOut() call entirely, leaving
      // both the session and RECOVERY_UNCONFIRMED_KEY untouched -- confirmed
      // as a real bug via a failing cold-load test before this was fixed.
      if (event === 'INITIAL_SESSION' && localStorage.getItem(RECOVERY_UNCONFIRMED_KEY) === '1') {
        client().auth.signOut();
        return;
      }
      const incomingEmail = session && session.user ? session.user.email : null;
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryPending(true, incomingEmail);
      } else if (event === 'SIGNED_OUT') {
        // A real, deliberate action that should win over a stale recovery
        // attempt -- e.g. a customer who abandoned an unfinished recovery
        // shouldn't stay stuck being shown the recovery step forever after.
        setRecoveryPending(false);
      } else if (event === 'SIGNED_IN') {
        // BUG FIX (real Chrome, confirmed via a temporary debug log + the
        // supabase-js source itself): this used to unconditionally clear a
        // pending recovery, on the theory that a genuine new login is a
        // deliberate action that should win over a stale recovery attempt.
        // True for a DIFFERENT account -- but supabase-js also fires a
        // completely genuine SIGNED_IN for the SAME account with zero
        // customer action behind it: switching back to this tab after
        // clicking the recovery link in another one fires a real
        // visibilitychange, and supabase-js's own _onVisibilityChanged() ->
        // _recoverAndRefresh() answers that by unconditionally re-notifying
        // SIGNED_IN for whatever valid session is already in shared storage
        // (confirmed by reading that function's own source) -- which, mid
        // recovery, IS the recovery session. Only a SIGNED_IN for a
        // genuinely different account should supersede a pending recovery;
        // this same-account case is that internal re-notification, not a
        // real login, and must never grant account access on its own.
        const pendingEmail = getRecoveryPendingEmail();
        if (!isPasswordRecovery() || !pendingEmail || !incomingEmail || pendingEmail.toLowerCase() !== incomingEmail.toLowerCase()) {
          setRecoveryPending(false);
        }
      } else if (event === 'USER_UPDATED' && !localAuthChangeInFlight) {
        // Only when NOT this tab's own local call (localAuthChangeInFlight
        // -- see updateUserLocally()'s own comment): covers setNewPassword()
        // completing (which ALSO calls setRecoveryPending(false) explicitly
        // and unconditionally itself, see that function's own comment --
        // this branch is redundant for that exact case, not the only thing
        // making it work) and, more importantly, a REMOTE USER_UPDATED
        // broadcast from another tab finishing the SAME recovery first (so a
        // second tab showing the same stale form doesn't stay stuck on it
        // after the reset already completed elsewhere) -- unlike SIGNED_IN
        // above, a same-account USER_UPDATED here IS exactly the "recovery
        // just completed" signal, not a spurious re-notification, so this
        // stays unconditional.
        //
        // BUG FIX: TOKEN_REFRESHED and a LOCAL USER_UPDATED both used to
        // ALSO clear this (found while re-auditing this exact logic for the
        // cross-tab security fix -- see AUTH_PASSWORD_RESET_REDIRECT_URL's
        // own updated comment for the full context). Both are real bugs,
        // not just theoretical: TOKEN_REFRESHED fires automatically in the
        // background purely from a session staying open long enough
        // (Supabase's own default auto-refresh, nothing to do with any
        // customer action) -- a customer who simply takes a few minutes to
        // read the requirements checklist and type/confirm a new password
        // could get silently booted out of the recovery step mid-attempt
        // for no reason connected to the recovery itself. A LOCAL
        // USER_UPDATED has the same problem via a different door: the
        // language-sync listener below calls updateUserLocally() (which
        // sets localAuthChangeInFlight) any time the site's language
        // changes, on ANY page, including while a customer is genuinely
        // mid-recovery -- switching FR/EN while typing a new password would
        // have cleared this the same way. INITIAL_SESSION was already
        // correctly excluded before this rewrite and still is here, simply
        // by not being in the allow-list -- it gets its own dedicated
        // handling above instead now (see this callback's very first check).
        setRecoveryPending(false);
      }
      currentAuthUser = session && session.user ? { id: session.user.id, email: session.user.email } : null;
      currentProfile = null;
      // A real session always wins over a leftover guest email -- e.g. a user
      // who started a guest checkout, then logged in on another tab.
      if (currentAuthUser) localStorage.removeItem(GUEST_KEY);
      notifySessionChange();
      // localAuthChangeInFlight (see its own comment above) is only ever true
      // while THIS tab's own updateUserLocally() call is in flight (Edit
      // Profile, the language sync, or reset-password.html/the in-page
      // recovery step's own setNewPassword()) -- false here means this
      // USER_UPDATED arrived from somewhere else via supabase-js's own
      // cross-tab BroadcastChannel, the one case mountAccountGate() doesn't
      // already have its own on-page confirmation for. Fired after
      // notifySessionChange() above (whose 'account:updated' resolveSession()
      // already handled synchronously by this point) so any listener sees an
      // already-resolved, up to date session underneath it.
      if (event === 'USER_UPDATED' && !localAuthChangeInFlight) {
        document.dispatchEvent(new CustomEvent('account:updated-elsewhere', {
          detail: { email: currentAuthUser ? currentAuthUser.email : null }
        }));
      }
    });

    // Best-effort half of "refresh/navigate away mid-recovery behaves like
    // Cancel" -- the actual guarantee is the INITIAL_SESSION check above,
    // which works regardless of whether this ever fires or finishes (see its
    // own comment on why signOut() can't be relied on to complete before a
    // page actually unloads). Still worth attempting: pagehide fires for
    // both a refresh and a real navigation (unlike beforeunload, which is
    // being restricted in several browsers and only reliably covers a
    // subset of this anyway), and when the browser DOES give it enough time
    // -- a normal same-tab link click, most refreshes -- this revokes the
    // session server-side right away instead of leaving that to whichever
    // page happens to load next.
    window.addEventListener('pagehide', () => {
      if (passwordRecoveryActive) logOut();
    });
  } else {
    console.error('MonarkAccount: Supabase client unavailable -- account features will fail until js/supabase-client.js has real SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY values.');
  }

  // Keeps a real (non-guest) account's own auth.users.user_metadata.language
  // in sync with whatever language they're actually browsing in right now --
  // see createAccount()'s own emailRedirectTo/language comment: this is what
  // supabase/functions/send-auth-email (the Send Email Auth Hook) reads to
  // pick FR/EN for password-reset/signup-confirmation/email-change emails.
  // Without this, an account's auth email language would stay frozen at
  // whatever it happened to be when they first signed up, even after they
  // later switch the site's language -- module-level (not inside
  // mountAccountGate()) since a language switch can happen on ANY page, not
  // just checkout.html/account.html. Best-effort, silent: never surfaced to
  // the UI, and a failure here has no visible consequence beyond the next
  // auth email using a stale language, not worth alarming anyone over.
  document.addEventListener('monark:langchange', () => {
    if (!currentAuthUser || !client()) return;
    const lang = window.MonarkI18n ? window.MonarkI18n.getLang() : 'fr';
    updateUserLocally({ data: { language: lang } }).then(({ error }) => {
      if (error) console.error('MonarkAccount: failed to sync language to user_metadata:', error.message);
    });
  });

  function mockCardKey(userId) { return MOCK_CARD_KEY_PREFIX + userId; }

  // Saved Card fields have no column in public.profiles (out of scope for
  // this migration -- see account.html's own "Mocked for demo purposes, no
  // real card data stored or processed" note on that form) -- kept exactly
  // as mocked as before, just namespaced per Supabase user id in
  // localStorage instead of embedded in the old flat account record.
  function readMockCard(userId) {
    try {
      const raw = localStorage.getItem(mockCardKey(userId));
      const card = raw ? JSON.parse(raw) : {};
      return card && typeof card === 'object' ? card : {};
    } catch (e) {
      return {};
    }
  }

  function writeMockCard(userId, patch) {
    localStorage.setItem(mockCardKey(userId), JSON.stringify(Object.assign({}, readMockCard(userId), patch)));
  }

  // Maps a public.profiles row (+ the mocked card fields above) onto the
  // same flat field names the old localStorage account record used, so
  // every existing reader (checkout.html's prefillShippingFromAccount(),
  // account.html's renderProfile()) needs no changes beyond awaiting the
  // now-async call that produces this object.
  function profileToAccountShape(row) {
    const card = currentAuthUser ? readMockCard(currentAuthUser.id) : {};
    return {
      email: currentAuthUser.email,
      firstName: row.first_name || '',
      lastName: row.last_name || '',
      dob: row.date_of_birth || '',
      address: row.address || '',
      // Client-side model property renamed from address2 -> extraDetails
      // (Supabase column itself, address_line_2, is untouched -- this is
      // purely a client-side/DOM naming fix, not a schema change). See
      // checkout.html's/account.html's own markup comment on this field's
      // name="address2" -> name="extraDetails" rename: Chrome's autofill
      // heuristic scans field name/id for address-shaped keywords
      // regardless of the autocomplete attribute, and "address2" was very
      // likely what it was keying off. Kept in sync here so the whole
      // client-side model uses the same name the DOM field now does.
      extraDetails: row.address_line_2 || '',
      city: row.city || '',
      postal: row.postal_code || '',
      phone: row.phone || '',
      dialCode: row.dial_code || '',
      country: row.country || '',
      marketingOptIn: row.marketing_opt_in !== false,
      cardName: card.cardName || '',
      cardNumber: card.cardNumber || '',
      cardExpiry: card.cardExpiry || ''
    };
  }

  function getSession() {
    if (currentAuthUser) return { email: currentAuthUser.email, isGuest: false };
    const guestEmail = localStorage.getItem(GUEST_KEY);
    if (guestEmail) return { email: guestEmail, isGuest: true };
    return null;
  }

  // getSession() deliberately doesn't expose the raw auth uid (see its own
  // comment history) -- this narrow addition is only for
  // checkout.html's create-checkout-session call, which needs it (as
  // userId, alongside a guest session's own email) so
  // supabase/functions/stripe-webhook can still attribute an order to the
  // right account from the PaymentIntent's own metadata even if this
  // browser tab never gets to run recordOrder() at all (closed right after
  // payment, network drop, etc.) -- see that function's own metadata
  // comment. null for a guest session (or no session).
  function getCurrentUserId() {
    return currentAuthUser ? currentAuthUser.id : null;
  }

  // REVISED: used to also check a sessionStorage marker so a refresh didn't
  // lose recovery-pending state -- deliberately doesn't any more.
  // passwordRecoveryActive alone, purely in-memory, is now the whole
  // definition of "show the recovery form": true only between a live
  // PASSWORD_RECOVERY event and that same page leaving recovery mode one way
  // or another, never reconstructed on a fresh load. The 1-hour-expiry logic
  // this function used to also enforce is gone too -- it existed only to
  // eventually clear a sessionStorage marker that no longer exists; an
  // in-memory flag already "expires" the instant the page unloads, which is
  // both simpler and stricter than any timer could be. (Distrusting a
  // lingering, never-confirmed recovery SESSION on a fresh load is still
  // handled -- see RECOVERY_UNCONFIRMED_KEY and onAuthStateChange's own
  // INITIAL_SESSION handling -- just not by this function, since that's a
  // "was a real session left behind" concern, not a "should the recovery
  // FORM be showing" one.)
  function isPasswordRecovery() {
    return passwordRecoveryActive;
  }

  // Only ever resolves for the CURRENTLY authenticated user's own email --
  // there is no client-safe way to look up an arbitrary email's account
  // (public.profiles has no email column, RLS blocks reading any other
  // user's row, and auth.users isn't exposed to the publishable key at all).
  // Every existing caller (checkout.html/account.html) only ever calls this
  // with the resolved session's own email, so this is a behavior-preserving
  // narrowing, not a functional loss for them.
  async function findAccount(email) {
    const needle = String(email || '').trim().toLowerCase();
    if (!needle || !currentAuthUser || currentAuthUser.email.toLowerCase() !== needle) return undefined;
    if (currentProfile) return profileToAccountShape(currentProfile);
    const { data, error } = await client().from('profiles').select('*').eq('id', currentAuthUser.id).single();
    if (error || !data) {
      if (error) console.error('MonarkAccount.findAccount:', error.message);
      return undefined;
    }
    currentProfile = data;
    return profileToAccountShape(currentProfile);
  }

  async function createAccount(email, password, extra) {
    extra = extra || {};
    const { data, error } = await client().auth.signUp({
      email: String(email || '').trim(),
      password: String(password || ''),
      options: {
        // BUG FIX: this call never set emailRedirectTo at all, unlike
        // requestPasswordReset()'s own resetPasswordForEmail() call below --
        // meaning the signup-confirmation link had no explicit destination
        // and depended entirely on Supabase's own default Site URL, which is
        // exactly the setting reported stuck on localhost (see this file's
        // own AUTH_EMAIL_REDIRECT_URL comment). Explicit here now, matching
        // the password-reset call, for the same reason.
        emailRedirectTo: AUTH_EMAIL_REDIRECT_URL,
        // Expected to be read by the public.profiles insert trigger already
        // set up in the Supabase SQL editor (handle_new_user(), see its own
        // updated definition in the migration this feature shipped with) --
        // if that trigger doesn't pull these from raw_user_meta_data, they
        // land empty/default until the user fills in Edit Profile
        // themselves. marketing_opt_in is coalesced to true server-side if
        // this key is ever missing (e.g. an older cached script), matching
        // profileToAccountShape()'s own "not false = true" default below.
        //
        // language is NOT read by handle_new_user() / public.profiles at
        // all -- it stays in auth.users.user_metadata only, which is exactly
        // what supabase/functions/send-auth-email (the Send Email Auth
        // Hook) reads straight off the hook payload's own `user` object to
        // pick FR/EN for this account's password-reset/signup-confirmation/
        // email-change emails going forward (see this file's own
        // monark:langchange listener above, which keeps it current after
        // signup too, not just at this one moment).
        data: {
          first_name: extra.firstName || '',
          last_name: extra.lastName || '',
          marketing_opt_in: extra.marketingOptIn !== false,
          phone: extra.phone || '',
          dial_code: extra.dialCode || '',
          country: extra.country || '',
          language: window.MonarkI18n ? window.MonarkI18n.getLang() : 'fr'
        }
      }
    });
    if (error) {
      if (/already registered|already exists/i.test(error.message)) return { ok: false, error: 'exists' };
      // Supabase's built-in email service throttles outbound confirmation
      // emails hard (a handful per hour) unless the project has custom SMTP
      // configured -- error.code is 'over_email_send_rate_limit' (HTTP 429)
      // when this trips. Worth a distinct, honest message rather than the
      // generic fallback: a burst of real signups will hit this in
      // production exactly like repeated testing does. Set up custom SMTP
      // (Supabase dashboard -> Authentication -> Emails/SMTP Settings) to
      // lift the default limit before launch.
      if (error.status === 429 || error.code === 'over_email_send_rate_limit') {
        return { ok: false, error: 'rate-limited', retryAfterSeconds: parseRetrySeconds(error.message) };
      }
      // Supabase's own server-side password policy (length/breach-list
      // checks, etc.) can reject a password the client-side isValidPassword()
      // check above already passed -- e.g. a password on Supabase's known-
      // weak/pwned list, which no client-side rule can predict. error.code
      // is 'weak_password' for this; the message-pattern fallback mirrors
      // this file's own same_password/already-registered detection, for the
      // same reason (a future Supabase wording change shouldn't silently
      // fall through to the generic error). Reuses accountGate.errorPasswordWeak
      // (the same copy the client-side check already shows) rather than a
      // second, near-duplicate string.
      if (error.code === 'weak_password' || /password/i.test(error.message)) return { ok: false, error: 'weak-password' };
      console.error('MonarkAccount.createAccount:', error.message);
      return { ok: false, error: 'unknown' };
    }
    // Supabase's own anti-enumeration behavior: signUp() against an
    // already-registered, confirmed email returns a fake "success" with an
    // empty identities array instead of an error, specifically so this
    // endpoint can't be used to probe which emails are registered. This is
    // the other half of that same protection.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      return { ok: false, error: 'exists' };
    }
    if (!data.session) {
      // This project's Auth settings require email confirmation -- there is
      // no session yet, the user has to click the link Supabase just
      // emailed before they can log in. Real behavior now, not the old
      // mock's instant fake "confirmation".
      return { ok: true, needsEmailConfirmation: true };
    }
    return { ok: true, needsEmailConfirmation: false };
  }

  // Verifies the 6-digit code Supabase's "Confirm signup" email sends via
  // {{ .Token }} (see the Supabase dashboard's own email template config --
  // this project's own is already set up to mail the code itself rather
  // than a clickable confirmation link) -- called by mountAccountGate()'s
  // own code step right after createAccount() above returns
  // needsEmailConfirmation. A successful verifyOtp() establishes a real
  // session itself, same as logIn()'s signInWithPassword() -- the caller
  // doesn't need to do anything else to "log in": onAuthStateChange's own
  // SIGNED_IN handling (top of this file) and the caller's resolveSession()
  // pick that session up exactly like any other.
  async function verifySignupOtp(email, token) {
    let result;
    try {
      result = await client().auth.verifyOtp({
        email: String(email || '').trim(),
        token: String(token || '').trim(),
        type: 'signup'
      });
    } catch (e) {
      return { ok: false, error: 'network' };
    }
    const { error } = result;
    if (error) {
      if (error.status === 429 || error.code === 'over_request_rate_limit' || /rate limit/i.test(error.message)) {
        return { ok: false, error: 'rate-limited' };
      }
      // supabase-js's own AuthRetryableFetchError (a real fetch failure --
      // offline, DNS, CORS -- rather than a server response) carries no
      // HTTP status at all, unlike every other branch here; that absence,
      // plus its own distinct error.name, is what tells this apart from a
      // genuine server-side rejection.
      if (error.name === 'AuthRetryableFetchError' || /network|fetch/i.test(error.message)) {
        return { ok: false, error: 'network' };
      }
      // BUG FIX: this used to pattern-match "expired" in error.message to
      // decide expired-vs-wrong-code right here -- but Supabase/GoTrue
      // deliberately returns the exact same generic "Token has expired or
      // is invalid" message for BOTH cases (same anti-enumeration reasoning
      // as logIn()'s own "Incorrect password" wording), so a customer
      // mistyping a digit seconds after signing up was shown "this code has
      // expired" purely because that word happens to appear in Supabase's
      // one shared error string. There is no reliable way to split the two
      // from the message alone -- 'token-invalid' reports the raw fact
      // (Supabase rejected this code) and leaves the actual classification
      // to the caller (mountAccountGate()'s own codeForm submit handler),
      // which knows the REAL elapsed time since the code was sent
      // (SIGNUP_OTP_SENT_AT_KEY vs. OTP_EXPIRY_MS) and can tell a code that
      // is mathematically still valid apart from one that genuinely can't be.
      if (/invalid|token|expired/i.test(error.message)) return { ok: false, error: 'token-invalid' };
      console.error('MonarkAccount.verifySignupOtp:', error.message);
      return { ok: false, error: 'unknown' };
    }
    return { ok: true };
  }

  // Re-sends the same 6-digit signup code to an email already mid-
  // verification -- supabase.auth.resend() (not a second signUp() call,
  // which would re-run the whole signup payload for no reason) issues a
  // fresh code/invalidates the previous one. mountAccountGate()'s own
  // "Resend code" link calls this, with its own 30-second cooldown gating
  // how often a customer can trigger it (see syncResendCountdown()) --
  // the over_email_send_rate_limit check here is Supabase's OWN, stricter
  // server-side throttle underneath that, for the same reason
  // createAccount()'s initial send checks it.
  async function resendSignupOtp(email) {
    let result;
    try {
      result = await client().auth.resend({ type: 'signup', email: String(email || '').trim() });
    } catch (e) {
      return { ok: false, error: 'network' };
    }
    const { error } = result;
    if (error) {
      if (error.status === 429 || error.code === 'over_email_send_rate_limit' || /rate limit/i.test(error.message)) {
        return { ok: false, error: 'rate-limited', retryAfterSeconds: parseRetrySeconds(error.message) };
      }
      // Same AuthRetryableFetchError detection as verifySignupOtp() above.
      if (error.name === 'AuthRetryableFetchError' || /network|fetch/i.test(error.message)) {
        return { ok: false, error: 'network' };
      }
      console.error('MonarkAccount.resendSignupOtp:', error.message);
      return { ok: false, error: 'unknown' };
    }
    return { ok: true };
  }

  // Server-side existence check via the check-email-exists Edge Function
  // (supabase/functions/check-email-exists) -- see that function's own
  // comment for why this can't be done client-side (no email column exposed,
  // RLS blocks any other user's row, and probing signUp()/signInWithPassword()
  // is exactly the enumeration attack Supabase's API design prevents). Used
  // by mountAccountGate() below to decide whether to show the login-only
  // view or the normal guest/create-account choices -- also exposed publicly
  // (see this file's own MonarkAccount export) for account-page.js's own
  // guest-with-an-existing-account Order History note, the same distinction
  // applied a second time outside the gate itself. Fails open (returns
  // false, the "doesn't exist" branch) on any network/server error, so a
  // transient failure here degrades to today's full three-option flow
  // instead of blocking the gate entirely.
  async function checkEmailExists(email) {
    const { data, error } = await client().functions.invoke('check-email-exists', {
      body: { email: String(email || '').trim() }
    });
    if (error || !data || typeof data.exists !== 'boolean') {
      console.error('MonarkAccount.checkEmailExists:', error ? error.message : 'unexpected response');
      return false;
    }
    return data.exists;
  }

  async function logIn(email, password) {
    const { error } = await client().auth.signInWithPassword({
      email: String(email || '').trim(),
      password: String(password || '')
    });
    // BUG FIX: accountGate.errorWrongPassword used to say "Incorrect email or
    // password" -- this login form is only ever reached once check-email-
    // exists has already confirmed the typed email DOES have an account (see
    // mountAccountGate()'s applyAuthOptionsVisibility()), so implying the
    // email itself might be wrong here was never actually possible and just
    // added doubt. The copy now says only "Incorrect password" in js/i18n.js.
    if (error) {
      // BUG FIX: an account that signed up but never confirmed its email
      // (never finished the code step) got the exact same "Incorrect
      // password" message on login as a genuinely wrong password --
      // Supabase correctly rejects the login either way, but for a totally
      // different reason the customer has no way to tell apart from that
      // message alone. error.code is 'email_not_confirmed' for this case;
      // the message-pattern fallback mirrors this file's own already-
      // registered/same-password detection, for the same reason (a future
      // Supabase wording change shouldn't silently fall through to the
      // generic "wrong password" branch). mountAccountGate()'s loginForm
      // handler reacts to this distinctly: resend a fresh code and hand the
      // customer straight to the code step instead of just failing login.
      if (error.code === 'email_not_confirmed' || /email not confirmed/i.test(error.message)) {
        return { ok: false, error: 'not-confirmed' };
      }
      return { ok: false, error: 'invalid' };
    }
    return { ok: true };
  }

  // Google sign-in -- supabase.auth.signInWithOAuth() with no custom `scopes`
  // option, so Supabase requests its own default Google scopes (email +
  // profile), exactly as asked. redirectTo is always THIS page, as it stands
  // right now (origin + pathname + search, hash dropped -- neither
  // checkout.html nor account.html ever puts anything meaningful there) --
  // not a fixed constant like AUTH_EMAIL_REDIRECT_URL/
  // AUTH_PASSWORD_RESET_REDIRECT_URL above, because unlike those two
  // (always-the-same email-link destinations), this has to return the
  // customer to wherever they actually started: checkout.html mid-checkout
  // (cart state is cart.js's own localStorage, untouched by this navigation)
  // or account.html. Same server-side allow-list caveat as those two
  // constants -- this exact URL (or a wildcard covering it) must also be on
  // Supabase Dashboard -> Authentication -> URL Configuration -> Redirect
  // URLs, or Supabase silently falls back to the project's Site URL instead.
  // By default this is a full top-level browser redirect (signInWithOAuth()
  // calls window.location.assign() on the authorize URL itself) -- a
  // synchronous `error` back from this call means the redirect never even
  // started (e.g. the Google provider isn't enabled/configured yet on the
  // Supabase side), not that the customer did anything wrong on Google's own
  // screen; a cancellation/denial THERE instead comes back as error params on
  // this same redirectTo URL once Google/Supabase redirect back here -- see
  // consumeOAuthErrorFromUrl() below for that half.
  async function signInWithGoogle() {
    const redirectTo = window.location.origin + window.location.pathname + window.location.search;
    sessionStorage.setItem(OAUTH_PROVIDER_PENDING_KEY, 'google');
    const { error } = await client().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo }
    });
    if (error) {
      console.error('MonarkAccount.signInWithGoogle:', error.message);
      return { ok: false };
    }
    return { ok: true };
  }

  // Facebook sign-in -- same shape/redirect handling as signInWithGoogle()
  // above, just with an explicit `scopes` (Supabase's own default Facebook
  // scope list doesn't include public_profile) and its own provider marker
  // (see OAUTH_PROVIDER_PENDING_KEY's own comment). Same server-side
  // allow-list caveat as Google: this project's Facebook Login app also
  // needs this exact redirect URL (or Supabase's callback URL, depending on
  // how the Facebook app is configured) allowed, or the provider rejects the
  // request before Supabase ever gets to redirect back here at all -- a
  // separate, Facebook-side setting from the Supabase Redirect URLs allow-
  // list AUTH_EMAIL_REDIRECT_URL's own comment documents. A Facebook account
  // that denies/has no email on file comes back as a server-side `error` on
  // this same redirectTo URL (consumeOAuthErrorFromUrl() below), not a
  // distinct code of its own -- mountAccountGate() pattern-matches its
  // error_description for "email" to show the dedicated no-email message.
  async function signInWithFacebook() {
    const redirectTo = window.location.origin + window.location.pathname + window.location.search;
    sessionStorage.setItem(OAUTH_PROVIDER_PENDING_KEY, 'facebook');
    const { error } = await client().auth.signInWithOAuth({
      provider: 'facebook',
      options: { redirectTo, scopes: 'email public_profile' }
    });
    if (error) {
      console.error('MonarkAccount.signInWithFacebook:', error.message);
      return { ok: false };
    }
    return { ok: true };
  }

  // Reads (and then strips, via history.replaceState -- so a refresh or the
  // back button can't re-trigger the same message) the `error`/`error_code`/
  // `error_description` params Supabase's OAuth callback appends to
  // redirectTo when the provider step itself failed -- most commonly the
  // customer clicking Cancel/Deny on Google's own consent screen
  // (error=access_denied), but also any other provider-side failure.
  // supabase-js's own URL handling only ever looks for a SUCCESSFUL
  // access_token/code in the URL; it silently ignores an `error` param
  // entirely, which is exactly why this has to be read by hand instead of
  // reacting to some onAuthStateChange event that will never fire for this
  // case. Checks both the query string and the hash fragment -- different
  // Supabase/GoTrue versions have used either for this, and checking both
  // costs nothing. Only the three OAuth-specific keys are removed from
  // whichever one(s) had them -- any other param already on the page (e.g.
  // checkout.html's own expressSuccess/total/email express-checkout params)
  // is left exactly as it was.
  function consumeOAuthErrorFromUrl() {
    const searchParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const errorCode = searchParams.get('error') || hashParams.get('error');
    if (!errorCode) return null;
    const errorDescription = searchParams.get('error_description') || hashParams.get('error_description');
    ['error', 'error_code', 'error_description'].forEach((key) => {
      searchParams.delete(key);
      hashParams.delete(key);
    });
    const newSearch = searchParams.toString();
    const newHash = hashParams.toString();
    history.replaceState(null, '', window.location.pathname + (newSearch ? '?' + newSearch : '') + (newHash ? '#' + newHash : ''));
    return { errorCode, errorDescription };
  }

  // BUG FIX: a pending signup verification used to be restored from
  // SIGNUP_OTP_PENDING_EMAIL_KEY on ANY fresh page load, including a
  // perfectly ordinary navigation (clicking a link, typing the URL) --
  // leaving index.html and coming back to account.html resurrected a code
  // step from an earlier visit the customer had already moved on from.
  // Only an actual reload or a back/forward navigation (the customer
  // genuinely returning to where they left off) should restore it now;
  // the Performance Navigation Timing API's own `type` is the standard way
  // to tell these apart ('navigate' vs 'reload' vs 'back_forward' vs
  // 'prerender'). A true bfcache restore never re-runs this script at all
  // (nothing is torn down to begin with, see enterCodeStep()'s own
  // pageshow listener for that case instead), so this function only ever
  // needs to decide between a fresh 'navigate' and everything else.
  // Defaults to "restorable" if the API is unavailable for any reason --
  // losing real in-progress state on an edge-case browser is worse than
  // occasionally restoring it one navigation too generously.
  function pendingSignupEmailIsRestorable() {
    try {
      const entries = performance && performance.getEntriesByType && performance.getEntriesByType('navigation');
      const navType = entries && entries[0] ? entries[0].type : null;
      return !navType || navType === 'reload' || navType === 'back_forward';
    } catch (e) {
      return true;
    }
  }

  // "m***.49@gmail.com" for "muriel.elise.49@gmail.com" -- first character +
  // exactly 3 asterisks + the local part's own last 3 characters + the full
  // "@domain". A local part of 4 characters or fewer (nothing meaningful
  // left to show after the first character and 3 more) collapses to just
  // "first character + ***" instead. Used everywhere this gate displays the
  // pending signup's address on screen (see setTextWithMaskedEmail() further
  // down) -- the REAL address only ever lives in pendingCodeEmail/
  // SIGNUP_OTP_PENDING_EMAIL_KEY for the actual verifyOtp()/resend() calls,
  // never written into the DOM as text.
  function maskEmailForDisplay(email) {
    const value = String(email || '');
    const at = value.indexOf('@');
    if (at <= 0) return value;
    const local = value.slice(0, at);
    const domain = value.slice(at);
    if (local.length <= 4) return local.charAt(0) + '***' + domain;
    return local.charAt(0) + '***' + local.slice(-3) + domain;
  }

  // No Supabase involvement of its own -- a guest session is still just an
  // email attached to this browser, not a registered account, exactly as
  // before. BUG FIX: now async -- mountAccountGate()'s changeBtn/
  // modifyEmailBtn no longer log out immediately when clicked (see
  // enterEmailEditMode()'s own comment, added so Cancel has an intact
  // session to restore), so a real logged-in user choosing "Continue as
  // Guest" for a different email can reach here while currentAuthUser is
  // still set. getSession() checks currentAuthUser before GUEST_KEY, so
  // without this the new guest email would be written but silently ignored
  // -- the UI would keep reporting the old real session. logOut() first
  // (only when there's actually a real session to clear -- it already
  // no-ops otherwise) ensures the guest email set right after actually wins.
  async function continueAsGuest(email) {
    if (currentAuthUser) await logOut();
    localStorage.setItem(GUEST_KEY, String(email || '').trim());
    notifySessionChange();
  }

  async function logOut() {
    localStorage.removeItem(GUEST_KEY);
    if (!currentAuthUser) {
      notifySessionChange();
      return;
    }
    const { error } = await client().auth.signOut();
    if (error) console.error('MonarkAccount.logOut:', error.message);
    // onAuthStateChange's SIGNED_OUT branch above already clears
    // currentAuthUser/currentProfile and dispatches 'account:updated' --
    // nothing left to do here even on error (signOut() clears the local
    // session regardless of whether the network call itself succeeded).
  }

  // patch may carry: email, password, firstName, lastName, dob, address,
  // extraDetails, city, postal, phone, dialCode, country, marketingOptIn,
  // cardName, cardNumber, cardExpiry -- shallow-merged the same way the old localStorage version
  // worked, just routed to three different places now: email/password go to
  // Supabase Auth, the profile fields go to public.profiles, and the
  // (still-mocked) card fields go to localStorage -- see writeMockCard()'s
  // own comment on why those never got a real table.
  async function updateAccount(currentEmail, patch) {
    if (!currentAuthUser || currentAuthUser.email.toLowerCase() !== String(currentEmail || '').trim().toLowerCase()) {
      return { ok: false, error: 'not-found' };
    }
    const cleanPatch = Object.assign({}, patch);
    // An empty "new password" field means "don't change it", not "set it to
    // the empty string" -- see account.html's Edit Profile form comment.
    if (cleanPatch.password === '') delete cleanPatch.password;

    const authPatch = {};
    if (cleanPatch.email !== undefined && String(cleanPatch.email).trim().toLowerCase() !== currentAuthUser.email.toLowerCase()) {
      authPatch.email = String(cleanPatch.email).trim();
    }
    if (cleanPatch.password !== undefined) authPatch.password = cleanPatch.password;

    let emailChangePending = false;
    if (Object.keys(authPatch).length) {
      const { error } = await updateUserLocally(authPatch);
      if (error) {
        if (/already registered|already exists/i.test(error.message)) return { ok: false, error: 'email-exists' };
        console.error('MonarkAccount.updateAccount (auth):', error.message);
        return { ok: false, error: 'unknown' };
      }
      // Changing email requires clicking a confirmation link (Supabase's
      // "secure email change" setting) -- the session's email doesn't flip
      // until that happens, unlike the old mock's instant rename. See
      // account.emailChangePending's copy, shown by account.html when this
      // comes back true.
      if (authPatch.email) emailChangePending = true;
    }

    const profilePatch = {};
    if (cleanPatch.firstName !== undefined) profilePatch.first_name = cleanPatch.firstName;
    if (cleanPatch.lastName !== undefined) profilePatch.last_name = cleanPatch.lastName;
    if (cleanPatch.dob !== undefined) profilePatch.date_of_birth = cleanPatch.dob || null;
    if (cleanPatch.address !== undefined) profilePatch.address = cleanPatch.address;
    if (cleanPatch.extraDetails !== undefined) profilePatch.address_line_2 = cleanPatch.extraDetails;
    if (cleanPatch.city !== undefined) profilePatch.city = cleanPatch.city;
    if (cleanPatch.postal !== undefined) profilePatch.postal_code = cleanPatch.postal;
    if (cleanPatch.phone !== undefined) profilePatch.phone = cleanPatch.phone;
    if (cleanPatch.dialCode !== undefined) profilePatch.dial_code = cleanPatch.dialCode;
    if (cleanPatch.country !== undefined) profilePatch.country = cleanPatch.country;
    if (cleanPatch.marketingOptIn !== undefined) profilePatch.marketing_opt_in = cleanPatch.marketingOptIn;

    if (Object.keys(profilePatch).length) {
      const { data, error } = await client().from('profiles').update(profilePatch).eq('id', currentAuthUser.id).select().single();
      if (error) {
        console.error('MonarkAccount.updateAccount (profile):', error.message);
        return { ok: false, error: 'unknown' };
      }
      currentProfile = data;
    }

    const cardPatch = {};
    if (cleanPatch.cardName !== undefined) cardPatch.cardName = cleanPatch.cardName;
    if (cleanPatch.cardNumber !== undefined) cardPatch.cardNumber = cleanPatch.cardNumber;
    if (cleanPatch.cardExpiry !== undefined) cardPatch.cardExpiry = cleanPatch.cardExpiry;
    if (Object.keys(cardPatch).length) writeMockCard(currentAuthUser.id, cardPatch);

    notifySessionChange();
    return { ok: true, emailChangePending };
  }

  // `session` is whatever getSession() currently returns (the call site
  // already has it in hand) -- recordOrder() needs to know isGuest to decide
  // between user_id and guest_email, which the old email-only signature
  // couldn't express. Guest orders get recorded too (public.orders has a
  // guest_email column specifically for this), where the old mock never
  // could since a guest had no account record to attach an order to.
  //
  // DESIGN NOTE -- why this still runs client-side at all now that
  // supabase/functions/stripe-webhook exists as the real authoritative
  // writer: recommendation was to KEEP this preliminary insert rather than
  // deleting it in favor of the webhook being the sole writer. Reasoning:
  // the webhook fires asynchronously, server-to-server, on Stripe's own
  // schedule (typically fast, but never guaranteed instant or even
  // guaranteed to arrive at all within any bounded window from this tab's
  // perspective) -- if this client-side insert were removed, a customer who
  // opens account.html's Order History in the first few seconds after
  // paying (very plausible right after a checkout) would see nothing there
  // at all, which reads as "did my order actually go through?" even though
  // the payment already succeeded. Recording a 'processing' row immediately
  // means SOMETHING is always there right away; the webhook then reconciles
  // it to 'paid' (+ a reference_number) once it actually lands, updating the
  // exact same row via payment_intent_id rather than creating a second one
  // -- see that function's own comment on how it races/reconciles against
  // this exact insert.
  //
  // order.paymentIntentId is what makes that reconciliation possible --
  // without it, the webhook would have no way to tell "is this the same
  // order this browser already recorded, or a genuinely new one" and could
  // only ever create its own separate row.
  async function recordOrder(session, order) {
    if (!session) return { ok: false };
    const row = {
      product_name: order.productName,
      quantity: order.quantity,
      total: order.total,
      payment_intent_id: order.paymentIntentId || null,
      // Authoritative flip to 'paid' (+ reference_number) happens
      // server-side, via supabase/functions/stripe-webhook, once
      // payment_intent.succeeded is verified -- never set directly from the
      // client, which has no way to actually prove Stripe confirmed the
      // charge (RLS also has no UPDATE policy for this table from the
      // client side at all, specifically so a row can never be
      // self-promoted to 'paid' this way -- see that migration's own
      // comment).
      status: 'processing'
    };
    // NOTE: public.orders has no promo_code column yet, so order.promoCode
    // (if present) is intentionally not persisted here -- add a column and
    // one more line here if that needs to survive into order history.
    if (session.isGuest) {
      row.guest_email = session.email;
    } else {
      if (!currentAuthUser) return { ok: false };
      row.user_id = currentAuthUser.id;
    }
    const { error } = await client().from('orders').insert(row);
    if (error && error.code !== '23505') {
      // Guest inserts need an RLS policy allowing an anonymous insert where
      // user_id IS NULL and guest_email IS NOT NULL -- if that isn't in
      // place yet, guest checkouts will fail here (permission denied) while
      // logged-in checkouts keep working.
      console.error('MonarkAccount.recordOrder:', error.message);
      return { ok: false };
    }
    // 23505 (unique_violation on payment_intent_id) means
    // supabase/functions/stripe-webhook already won the race and inserted
    // this exact order first (fast payment confirmation + a slightly
    // delayed client) -- not a real failure, same duplicate-insert-as-
    // success handling js/email-popup.js's newsletter capture already uses.
    return { ok: true };
  }

  // Same "current user only" narrowing as findAccount() -- RLS already
  // enforces this server-side, this is just the client-side mirror of it.
  async function getOrders(email) {
    if (!currentAuthUser || currentAuthUser.email.toLowerCase() !== String(email || '').trim().toLowerCase()) return [];
    const { data, error } = await client()
      .from('orders')
      .select('*')
      .eq('user_id', currentAuthUser.id)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('MonarkAccount.getOrders:', error.message);
      return [];
    }
    return data.map((row) => ({
      date: row.created_at,
      productName: row.product_name,
      quantity: row.quantity,
      total: row.total,
      // status starts 'processing' (recordOrder()'s own client-side insert)
      // and flips to 'paid' once supabase/functions/stripe-webhook
      // reconciles it -- referenceNumber is only ever assigned at that same
      // moment (see that function's own comment), so it stays null/undefined
      // here until then. paymentIntentId is exposed so checkout.html's
      // confirmation screen can match its own in-flight PaymentIntent
      // against this list while polling for the reference number to appear
      // (see completeOrder()'s own comment on that).
      status: row.status,
      referenceNumber: row.reference_number,
      paymentIntentId: row.payment_intent_id,
      // shippingStatus starts 'pending' (public.orders' own default) and
      // flips to 'shipped' via supabase/functions/mark-order-shipped, which
      // is also the only writer of shippedAt (set once, on that first
      // transition -- see that function's own comment). deliveredAt is
      // scaffolding for a planned automated delivery-detection feature --
      // always null today, nothing writes it yet (see
      // supabase/functions/check-delivery-status's own placeholder
      // structure and 20260829000000_order_shipped_delivered_timestamps.sql).
      shippingStatus: row.shipping_status,
      shippedAt: row.shipped_at,
      deliveredAt: row.delivered_at,
      // Already selected via this query's own `select('*')` above -- these
      // three are just newly exposed on the returned object (same columns
      // supabase/functions/mark-order-shipped itself writes), not a new DB
      // column, so js/account-page.js's "Suivre mon colis" link can build
      // the same carrier tracking URL that file's own carrierTrackingUrl()
      // already builds for the shipping email.
      trackingNumber: row.tracking_number,
      carrier: row.carrier,
      shippingPostalCode: row.shipping_postal_code
    }));
  }

  // SECURITY FIX: this used to just call logOut() and report success --
  // full account deletion (removing the auth.users row, and by cascade its
  // profiles row -- see supabase/functions/delete-account's own comment on
  // the ON DELETE CASCADE/SET NULL behavior confirmed directly against the
  // live schema) requires Supabase's admin/service-role API, which the
  // publishable key this file uses can't call directly (and a service-role
  // key must never ship client-side -- it bypasses RLS entirely for every
  // table). "Delete Account" looked like it worked (the UI signed out
  // immediately) but never removed anything server-side -- the account,
  // profile, and order history were all still there on the next log-in.
  // Now routed through that Edge Function instead, which performs the real
  // deletion using the service-role key server-side.
  async function deleteAccount(email) {
    const { error } = await client().functions.invoke('delete-account');
    if (error) {
      console.error('MonarkAccount.deleteAccount:', error.message);
      return { ok: false };
    }
    await logOut();
    return { ok: true };
  }

  async function requestPasswordReset(email) {
    const { error } = await client().auth.resetPasswordForEmail(String(email || '').trim(), {
      redirectTo: AUTH_PASSWORD_RESET_REDIRECT_URL
    });
    if (error) {
      // Same over_email_send_rate_limit (HTTP 429) throttle documented on
      // createAccount() above -- confirmed live: requesting a reset twice
      // within ~60s for the same address trips this. Surface it distinctly
      // instead of the generic "check the address" message, which is
      // actively misleading here (the address is fine).
      if (error.status === 429 || error.code === 'over_email_send_rate_limit') {
        return { ok: false, error: 'rate-limited' };
      }
      console.error('MonarkAccount.requestPasswordReset:', error.message);
      return { ok: false, error: 'unknown' };
    }
    return { ok: true };
  }

  // Only meaningful while isPasswordRecovery() is true (the user arrived via
  // a password-reset email link, which gives them a temporary recovery
  // session authorized to call this) -- see mountAccountGate()'s recovery
  // step below.
  async function setNewPassword(password) {
    const { error } = await updateUserLocally({ password: String(password || '') });
    if (error) {
      // Supabase rejects setting the account's CURRENT password again as
      // the "new" one -- error.code is 'same_password' when this trips.
      // Message-pattern fallback alongside it for the same reason
      // createAccount()'s own already-registered detection above does the
      // same: a specific code lookup could miss a future wording/shape
      // change Supabase makes on their end without notice.
      if (error.code === 'same_password' || /different from the old|same as the old|same as your current/i.test(error.message)) {
        return { ok: false, error: 'same-password' };
      }
      console.error('MonarkAccount.setNewPassword:', error.message);
      return { ok: false, error: 'unknown' };
    }
    // onAuthStateChange's own USER_UPDATED branch above already calls
    // setRecoveryPending(false) for this exact same successful call (see
    // updateUserLocally()'s own comment: the underlying auth.updateUser()
    // awaits _notifyAllSubscribers() before its promise resolves, so that
    // branch has already run by the time control returns here) -- explicit
    // here too anyway, matching how passwordRecoveryActive alone already
    // was before, rather than leaving this function looking like it does
    // nothing on success.
    setRecoveryPending(false);
    notifySessionChange();
    return { ok: true };
  }

  /* ---------------- Shared account-gate UI ----------------
     The email -> guest/log-in/create-account flow was originally built as a
     one-off inline script in checkout.html. account.html needs the exact
     same flow (same steps, same validation, same markup/classes), and
     duplicating that script into a second file would mean every future fix
     has to be made twice and will eventually drift -- so it lives here
     instead, as the one shared implementation, and both pages just mount it
     into a container element with page-specific labels/callbacks.

     One real structural change from the old mock: the old flow branched
     into either a "log in" step or a "create account" step based on
     findAccount(email) deciding whether that email already had a record.
     Real Supabase Auth has no client-safe way to make that same call (no
     email column exposed, RLS blocks any other user's row, and probing
     sign-up/sign-in as a way to test "does this email exist" is exactly the
     enumeration attack Supabase's own API design goes out of its way to
     prevent -- see createAccount()'s and logIn()'s own comments on that).
     So instead of guessing, every plausible email now reveals ALL THREE
     options at once -- Log In, Continue as Guest, Create an Account -- and
     the user picks the right one themselves. Same three actions as before,
     just no longer gated behind a guess this system can no longer safely
     make. */
  // Static labels below carry data-i18n tags -- window.MonarkI18n.apply() is
  // called on this markup right after it's mounted (see mountAccountGate())
  // for the first render, and a later language switch's own global
  // apply(document) pass re-walks it automatically since it's part of
  // `document` by then. Only the *dynamic*, multi-condition error/status
  // messages are NOT tagged this way -- those are set via MonarkI18n.t()
  // fresh at the moment they're shown instead, same pattern as
  // js/email-popup.js's own per-condition error messages.
  function accountGateMarkup() {
    // See FACEBOOK_LOGIN_ENABLED's own comment at the top of this file --
    // the button (and its error paragraph) simply isn't part of the markup
    // at all while it's off, so there's nothing for showStep()/the click
    // handler below to toggle and no gap left in the layout: the "or"
    // divider's own spacing sits right above whatever comes right after it,
    // Google alone or Google-then-Facebook, unchanged either way.
    const facebookBlock = FACEBOOK_LOGIN_ENABLED ? `
      <!-- Facebook sign-in -- same bypass-the-form shape as the Google
           button just above (see signInWithFacebook() for the actual
           supabase.auth.signInWithOAuth() call), placed directly under it
           with no extra divider: the single "or" above already separates
           the email path from "sign in with a provider", and this is a
           second option within that same group. Icon is a single-color "f"
           mark (css/checkout.css colors it via currentColor) rather than
           Facebook's own blue, matching this flow's "no bright brand colors
           besides Google's own required multicolor mark" treatment. -->
      <button type="button" class="cta-button checkout-account-btn-sm checkout-account-btn-secondary checkout-account-facebook-btn" id="checkout-account-facebook-btn">
        <svg class="checkout-account-facebook-icon" viewBox="0 0 320 512" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M279.14 288l14.22-92.66h-88.91v-66.76c0-25.35 12.42-50.06 52.24-50.06h40.42V6.26S260.43 0 225.36 0c-73.22 0-121.08 44.38-121.08 124.72v70.62H22.89V288h81.39v224h100.17V288z"></path>
        </svg>
        <span data-i18n="accountGate.continueWithFacebook">Continue with Facebook</span>
      </button>
      <p class="promo-message promo-message-error" id="checkout-account-facebook-error" aria-live="polite" hidden></p>` : '';
    return `
      <p class="checkout-account-status" id="checkout-account-status" hidden>
        <span id="checkout-account-status-text"></span>
        <span class="checkout-account-status-actions">
          <button type="button" class="checkout-account-link-btn" id="checkout-account-change-btn"></button>
          <button type="button" class="checkout-account-link-btn" id="checkout-account-guest-upgrade-btn" data-i18n="accountGate.createAccountBtn" hidden>Create Account</button>
          <button type="button" class="checkout-account-link-btn" id="checkout-account-modify-email-btn" data-i18n="accountGate.modifyEmail">Modify Email</button>
        </span>
      </p>
      <p class="promo-message promo-message-success" id="checkout-account-created-note" aria-live="polite" hidden></p>
      <!-- Shown only for a session change that arrived from elsewhere (see
           account:updated-elsewhere, dispatched by this file's own
           onAuthStateChange) -- reset-password.html finishing in another tab
           is the real-world case, but the trigger is generic (any
           out-of-band auth.updateUser()), so the copy stays generic too. -->
      <p class="promo-message promo-message-success" id="checkout-account-elsewhere-note" aria-live="polite" hidden></p>

      <form id="checkout-account-email-form" novalidate>
        <p class="checkout-account-intro" data-i18n="accountGate.intro">Please enter your email to continue as a guest, log in, or create an account.</p>
        <label class="checkout-field">
          <span data-i18n="accountGate.emailLabel">Email</span>
          <input type="email" id="checkout-account-email-input" autocomplete="email" required>
        </label>
        <p class="promo-message promo-message-error" id="checkout-account-email-error" aria-live="polite" hidden></p>
        <span class="checkout-account-email-actions">
          <button type="button" class="checkout-account-link-btn" id="checkout-account-email-cancel-btn" data-i18n="accountGate.cancelEdit" hidden>Cancel</button>
          <button type="submit" class="cta-button checkout-account-btn-sm" id="checkout-account-email-submit-btn" data-i18n="accountGate.continueBtn">Continue</button>
        </span>
      </form>

      <!-- Google sign-in bypasses the email/password form entirely -- see
           signInWithGoogle() below for the actual supabase.auth.signInWithOAuth()
           call. Shown/hidden together with checkout-account-email-form itself
           (see showStep()), never during the auth/create/recovery steps,
           where the customer has already committed to the email/password
           path. googleError surfaces both a failed signInWithOAuth() call
           (network/config issue, caught synchronously) and a cancelled/failed
           Google consent screen reported back via URL error params on this
           same page load (see consumeOAuthErrorFromUrl()). -->
      <p class="checkout-account-divider" id="checkout-account-google-divider"><span data-i18n="accountGate.orDivider">or</span></p>
      <button type="button" class="cta-button checkout-account-btn-sm checkout-account-btn-secondary checkout-account-google-btn" id="checkout-account-google-btn">
        <svg class="checkout-account-google-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
          <path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"></path>
          <path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"></path>
          <path fill="#4CAF50" d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"></path>
          <path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571c0.001-0.001,0.002-0.001,0.003-0.002l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"></path>
        </svg>
        <span data-i18n="accountGate.continueWithGoogle">Continue with Google</span>
      </button>
      <p class="promo-message promo-message-error" id="checkout-account-google-error" aria-live="polite" hidden></p>
${facebookBlock}
      <div id="checkout-account-auth" hidden>
        <p class="checkout-account-email-echo">
          <span id="checkout-account-auth-email"></span>
          <span class="checkout-account-email-echo-actions">
            <button type="button" class="checkout-account-link-btn" id="checkout-account-auth-cancel-btn" data-i18n="accountGate.cancelEdit" hidden>Cancel</button>
            <button type="button" class="checkout-account-link-btn" id="checkout-account-auth-modify-email-btn" data-i18n="accountGate.modifyEmail">Modify Email</button>
          </span>
        </p>
        <p class="promo-message" id="checkout-account-email-exists-note" aria-live="polite" hidden></p>

        <form id="checkout-account-login-form" novalidate>
          <label class="checkout-field">
            <span data-i18n="accountGate.passwordLabel">Password</span>
            <input type="password" id="checkout-account-login-password" autocomplete="current-password" required>
          </label>
          <p class="promo-message promo-message-error" id="checkout-account-login-error" aria-live="polite" hidden></p>
          <span class="checkout-account-login-actions">
            <button type="submit" class="cta-button checkout-account-btn-sm" id="checkout-account-login-submit-btn" data-i18n="accountGate.logInBtn">Log In</button>
            <button type="button" class="checkout-account-link-btn" id="checkout-account-forgot-password-btn" data-i18n="accountGate.forgotPassword">Forgot password?</button>
          </span>
          <p class="promo-message" id="checkout-account-forgot-password-status" aria-live="polite" hidden></p>
        </form>

        <div class="checkout-account-options" id="checkout-account-options">
          <button type="button" class="cta-button checkout-account-btn-sm checkout-account-btn-secondary" id="checkout-account-guest-btn" data-i18n="accountGate.continueAsGuest">Continue as Guest</button>
          <button type="button" class="cta-button checkout-account-btn-sm" id="checkout-account-create-toggle" data-i18n="accountGate.createAccountInstead">Create an account instead</button>
        </div>

        <!-- Shown instead of continuing straight to guest whenever guestBtn
             is clicked for an email that already has a real account
             (emailAlreadyExists) -- see guestBtn's own click handler and
             checkout-account-guest-password-form's submit handler further
             below for the full sign-in/pre-fill/revert-to-guest sequence.
             Reset (re-hidden, cleared) every time the auth step is freshly
             entered, see applyAuthOptionsVisibility(). -->
        <div id="checkout-account-guest-password-block" hidden>
          <p class="checkout-account-intro" data-i18n="accountGate.guestPasswordIntro">Enter your password to pre-fill your saved information, or continue without it.</p>
          <form id="checkout-account-guest-password-form" novalidate>
            <label class="checkout-field">
              <span data-i18n="accountGate.passwordLabel">Password</span>
              <input type="password" id="checkout-account-guest-password-input" autocomplete="current-password" required>
            </label>
            <p class="promo-message promo-message-error" id="checkout-account-guest-password-error" aria-live="polite" hidden></p>
            <!-- Own class, not the shared .checkout-account-login-actions (that
                 one wraps a DIFFERENT pair, Log In + Forgot password, with its
                 own unrelated stacked/right-aligned treatment) -- see
                 .account-delete-actions's own comment in css/checkout.css for
                 the same "reused a class, inherited the wrong pair's styling,
                 own class instead" fix. Skip comes before Continue in the DOM
                 (same "swap the order so the primary action lands on the
                 visual right" approach .checkout-account-email-actions's own
                 Cancel+Continue already uses) -- css/checkout.css flips this
                 to a column on mobile via flex-direction, not a second
                 physical ordering, so Continue still renders first/top there. -->
            <span class="checkout-account-guest-password-actions">
              <button type="button" class="checkout-account-link-btn" id="checkout-account-guest-password-skip-btn" data-i18n="accountGate.guestPasswordSkip">Continue without password</button>
              <button type="submit" class="cta-button checkout-account-btn-sm" id="checkout-account-guest-password-submit-btn" data-i18n="accountGate.continueBtn">Continue</button>
            </span>
          </form>
        </div>

        <form id="checkout-account-create-form" class="checkout-account-create-form" novalidate hidden>
          <div class="checkout-field-row">
            <label class="checkout-field">
              <span data-i18n="account.firstNameLabel">First Name</span>
              <input type="text" id="checkout-account-create-firstname" autocomplete="given-name" maxlength="50" required>
            </label>
            <label class="checkout-field">
              <span data-i18n="account.lastNameLabel">Last Name</span>
              <input type="text" id="checkout-account-create-lastname" autocomplete="family-name" maxlength="50" required>
            </label>
          </div>
          <label class="checkout-field">
            <span data-i18n="accountGate.passwordLabel">Password</span>
            <input type="password" id="checkout-account-create-password" autocomplete="new-password" required>
            <!-- Live-updating replacement for a static hint (see the
                 isValidPassword() rule -- this function's own createForm
                 submit handler further below -- for what's actually
                 enforced): each item below flips from muted/unmet to
                 bronze/met in real time as the user types (see
                 updatePasswordRequirements()), rather than only surfacing
                 what's wrong after a rejected submit. aria-label carries
                 the same accountGate.passwordHint copy the static version
                 used to show, as a single-string summary for assistive
                 tech that doesn't benefit from four separately-announced
                 live items. -->
            <ul class="password-requirements" id="checkout-account-create-password-requirements" data-i18n-attr="aria-label:accountGate.passwordHint" aria-label="Minimum 8 characters, with at least one letter, one number, and one special character (e.g. ! @ # $ % ? -).">
              <li class="password-requirement" data-requirement="length"><span class="password-requirement-icon" aria-hidden="true">○</span><span data-i18n="accountGate.passwordReqLength">8+ characters</span></li>
              <li class="password-requirement" data-requirement="letter"><span class="password-requirement-icon" aria-hidden="true">○</span><span data-i18n="accountGate.passwordReqLetter">One letter</span></li>
              <li class="password-requirement" data-requirement="number"><span class="password-requirement-icon" aria-hidden="true">○</span><span data-i18n="accountGate.passwordReqNumber">One number</span></li>
              <li class="password-requirement" data-requirement="special"><span class="password-requirement-icon" aria-hidden="true">○</span><span data-i18n="accountGate.passwordReqSpecial">One special character (e.g. ! @ # $ % ? -)</span></li>
            </ul>
          </label>
          <label class="checkout-field">
            <span data-i18n="accountGate.confirmPasswordLabel">Confirm Password</span>
            <input type="password" id="checkout-account-create-confirm" autocomplete="new-password" required>
          </label>
          <label class="checkout-field">
            <span data-i18n="accountGate.phoneLabel">Phone Number (optional)</span>
            <div id="checkout-account-create-phone"></div>
          </label>
          <label class="account-toggle-row checkout-account-marketing-row">
            <input type="checkbox" id="checkout-account-create-marketing" checked>
            <span data-i18n-html="accountGate.marketingLabel">I'd like to receive product updates, promotions, and the MONARK newsletter by email. You can change this anytime from your Account page &mdash; see our <a href="confidentialite.html" target="_blank" rel="noopener">Privacy Policy</a> for details.</span>
          </label>
          <p class="promo-message promo-message-error" id="checkout-account-create-error" aria-live="polite" hidden></p>
          <button type="submit" class="cta-button checkout-account-btn-sm" id="checkout-account-create-submit-btn" data-i18n="accountGate.createAccountAndContinue">Create Account &amp; Continue</button>
        </form>
      </div>

      <!-- Email-code (OTP) step -- shown right after createForm's own
           submit handler below gets needsEmailConfirmation back from
           signUp(), or after loginForm's own email_not_confirmed handling
           below resends a code for an account that was never confirmed.
           Supabase's "Confirm signup" email sends the 6-digit code via
           {{ .Token }} (dashboard-side template config, not anything this
           file controls) -- verified here with verifySignupOtp()
           (supabase.auth.verifyOtp({..., type: 'signup'})) instead of the
           old click-a-link flow. Reachable fresh, on a page reload mid-
           verification (SIGNUP_OTP_PENDING_EMAIL_KEY's own persisted email),
           or simply left alone across a tab switch/visibilitychange while
           still pending -- see mountAccountGate()'s pendingCodeEmail/
           codeStepActive/enterCodeStep() for all three. -->
      <div id="checkout-account-code" hidden>
        <!-- One sentence, not two separate lines -- "Enter the code sent
             to" plus the masked address live in the SAME <p>, built by
             setTextWithMaskedEmail() below (same split-on-{placeholder} +
             real element approach as setTextWithBoldValue(), just wrapping
             a plain <span> instead of <strong>). The real address is never
             written here -- only ever the masked form (see
             maskEmailForDisplay()); it stays in pendingCodeEmail/
             sessionStorage for the actual verify()/resend() calls. -->
        <p class="checkout-account-intro" id="checkout-account-code-intro"></p>
        <form id="checkout-account-code-form" novalidate>
          <!-- A real <fieldset>/<legend> still groups the six boxes for
               assistive tech -- the legend text itself is visually hidden
               (checkout-account-code-legend, css/checkout.css) rather than
               shown as on-page copy: the sentence above already says what
               to do, and spelling out "6-digit code" again as a separate
               visible heading was redundant on screen, though a screen
               reader still benefits from the group having its own label. -->
          <fieldset class="checkout-account-code-fieldset">
            <legend class="checkout-account-code-legend" data-i18n="accountGate.codeFieldLabel">6-digit code</legend>
            <div class="checkout-account-code-boxes" id="checkout-account-code-boxes">
              <input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="1" class="checkout-account-code-box" data-i18n-attr="aria-label:accountGate.codeDigit1" aria-label="Digit 1 of 6">
              <input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="1" class="checkout-account-code-box" data-i18n-attr="aria-label:accountGate.codeDigit2" aria-label="Digit 2 of 6">
              <input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="1" class="checkout-account-code-box" data-i18n-attr="aria-label:accountGate.codeDigit3" aria-label="Digit 3 of 6">
              <input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="1" class="checkout-account-code-box" data-i18n-attr="aria-label:accountGate.codeDigit4" aria-label="Digit 4 of 6">
              <input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="1" class="checkout-account-code-box" data-i18n-attr="aria-label:accountGate.codeDigit5" aria-label="Digit 5 of 6">
              <input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="1" class="checkout-account-code-box" data-i18n-attr="aria-label:accountGate.codeDigit6" aria-label="Digit 6 of 6">
            </div>
          </fieldset>
          <!-- Single shared status line for this whole step -- every
               message (wrong/truly-expired code, attempts remaining,
               locked-out, rate limit, network error, resend success, the
               "wasn't confirmed yet" notice) goes through here, never two
               separate error/success paragraphs -- see showCodeStatus().
               Hidden/empty whenever none of those apply (in particular:
               never shown just because a fresh code was sent -- see
               enterCodeStep()'s own comment on BUG FIX 3). -->
          <p class="promo-message" id="checkout-account-code-status" aria-live="polite" hidden></p>
          <!-- No submit button -- the 6th digit auto-submits (unchanged),
               this just removes the extra bordered button underneath that
               used to wrap awkwardly on narrow screens. Two plain-text
               helper lines instead of two bordered .checkout-account-link-btn
               buttons, each pairing a muted static prompt with one inline,
               underlined link (.checkout-account-inline-link) for the
               actual action -- reads as a sentence, not a form field. -->
          <p class="checkout-account-code-helper-line">
            <span data-i18n="accountGate.codeResendPrompt">Didn't get it?</span>
            <button type="button" class="checkout-account-inline-link" id="checkout-account-code-resend-btn" data-i18n="accountGate.resendCode">Resend code</button>
          </p>
          <p class="checkout-account-code-helper-line">
            <span data-i18n="accountGate.codeModifyEmailPrompt">Wrong address?</span>
            <button type="button" class="checkout-account-inline-link" id="checkout-account-code-modify-email-btn" data-i18n="accountGate.codeModifyEmailLink">Change email</button>
          </p>
        </form>
      </div>

      <!-- Reached not by anything clicked on THIS page, but by this tab
           picking up a real PASSWORD_RECOVERY session established by
           reset-password.html in another tab, via supabase-js's own
           cross-tab broadcast (see AUTH_PASSWORD_RESET_REDIRECT_URL's own
           comment above for the full picture) -- mountAccountGate()'s
           resolveSession() shows this step the moment isPasswordRecovery()
           is true, ahead of the normal email/login/create-account steps.
           Same requirements-checklist + confirm-password pattern as
           reset-password.html used to have directly (that page now only
           points back here, see its own header comment) -- ported rather
           than duplicated-and-diverged: updatePasswordRequirements() below
           is shared with the create-account form above, just parameterized
           per call site now. -->
      <div id="checkout-account-recovery" hidden>
        <p class="checkout-account-intro" data-i18n="accountGate.setNewPasswordHeading">Set a New Password</p>
        <!-- Text populated by setTextWithBoldValue() (this file, used
             already for the "reset email sent" message above) -- never
             innerHTML/data-i18n-html: the email is session-supplied, not
             this project's own authored copy. -->
        <p class="checkout-account-intro" id="checkout-account-recovery-email-line"></p>
        <form id="checkout-account-recovery-form" novalidate>
          <label class="checkout-field">
            <span data-i18n="accountGate.newPasswordLabel">New Password</span>
            <input type="password" id="checkout-account-recovery-password" autocomplete="new-password" required>
            <ul class="password-requirements" id="checkout-account-recovery-password-requirements" data-i18n-attr="aria-label:accountGate.passwordHint" aria-label="Minimum 8 characters, with at least one letter, one number, and one special character (e.g. ! @ # $ % ? -).">
              <li class="password-requirement" data-requirement="length"><span class="password-requirement-icon" aria-hidden="true">○</span><span data-i18n="accountGate.passwordReqLength">8+ characters</span></li>
              <li class="password-requirement" data-requirement="letter"><span class="password-requirement-icon" aria-hidden="true">○</span><span data-i18n="accountGate.passwordReqLetter">One letter</span></li>
              <li class="password-requirement" data-requirement="number"><span class="password-requirement-icon" aria-hidden="true">○</span><span data-i18n="accountGate.passwordReqNumber">One number</span></li>
              <li class="password-requirement" data-requirement="special"><span class="password-requirement-icon" aria-hidden="true">○</span><span data-i18n="accountGate.passwordReqSpecial">One special character (e.g. ! @ # $ % ? -)</span></li>
            </ul>
          </label>
          <label class="checkout-field">
            <span data-i18n="accountGate.confirmPasswordLabel">Confirm Password</span>
            <input type="password" id="checkout-account-recovery-confirm" autocomplete="new-password" required>
            <!-- Live-updating, same as reset-password.html's own former
                 confirm field -- shown as-you-type, not just on submit,
                 since this field's whole job is keeping Set Password
                 disabled until it actually matches. -->
            <p class="promo-message promo-message-error" id="checkout-account-recovery-confirm-error" aria-live="polite" hidden></p>
          </label>
          <p class="promo-message promo-message-error" id="checkout-account-recovery-error" aria-live="polite" hidden></p>
          <span class="checkout-account-recovery-actions">
            <!-- Signs out of the temporary recovery session entirely (not
                 just a UI step-back) -- see recoveryCancelBtn's own click
                 handler below for why: a password-recovery link grants a
                 real, temporary Supabase session, so merely hiding this step
                 without also logging out would leave the account fully
                 accessible with no new password ever set, exactly the bug
                 this whole flow exists to prevent. -->
            <button type="button" class="checkout-account-link-btn" id="checkout-account-recovery-cancel-btn" data-i18n="accountGate.cancelRecovery">Continue without changing your password</button>
            <button type="submit" class="cta-button checkout-account-btn-sm" id="checkout-account-recovery-submit-btn" data-i18n="accountGate.setNewPasswordBtn" disabled>Set Password</button>
          </span>
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
       - onResolved(session, { identityChanged }): called once a session
         exists (on mount, and after every successful log-in/guest/create-
         account/recovery, and after Cancel restores a session unchanged).
         identityChanged is true only when this resolution followed a
         completed changeBtn/modifyEmailBtn edit that landed on a genuinely
         different email/guest-status than before -- false on every other
         call, including Cancel (nothing changed) and the very first
         resolution at mount (nothing to compare against).
       - onUnresolved(): called whenever there's no session (on mount, and
         after changeLabel's button is clicked)
       - onGuestAuthenticated(session): optional, checkout.html-only in
         practice (guestBtn is always hidden on account.html, see
         hideGuestOption below, so its own click handler -- the only call
         site -- can never fire there). Called with a real (isGuest: false)
         session right after a customer chose Guest for an email that
         already has an account and then successfully verified that
         account's password -- while that momentary real session is still
         active, before it's reverted to guest (see guestPasswordForm's own
         submit handler further down for the full sequence). Meant for
         pre-filling account-specific form fields (checkout-page.js wires
         this to its own prefillShippingFromAccount()) that need a real,
         RLS-authorized session to read from -- never for anything that
         should outlive this single call.
     Returns { resolveSession } in case the host page ever needs to force a
     re-check (account.html uses this after deleteAccount() and its own
     guest-to-create-account shortcut). */
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
    // Optional -- fired whenever the gate shows an editable email/auth step
    // WHILE a previous session may still be intact (enterEmailEditMode()/
    // authModifyEmailBtn below), as distinct from onUnresolved (a real "no
    // session" state, i.e. actually logged out). checkout.html doesn't pass
    // this (nothing there depends on it); account.html uses it to hide its
    // own page-level "Mode Admin" button the instant the gate stops showing
    // a fully resolved session, even though the underlying Supabase session
    // -- and therefore resolveSession()'s own dedup -- hasn't changed at all
    // (see enterEmailEditMode()'s own comment on why nothing is torn down).
    const onEnterEditMode = typeof options.onEnterEditMode === 'function' ? options.onEnterEditMode : () => {};
    const statusLabel = options.statusLabel || function (session) {
      return session.isGuest
        ? t('accountGate.guestDefault', { email: session.email })
        : t('accountGate.loggedInAs', { email: session.email });
    };
    // account.html passes this true -- that page is only for logging into or
    // creating a real account, so "Continue as Guest" never makes sense
    // there regardless of what the email-existence check below finds. Also
    // gates one related account.html-only UI difference below: the
    // create-account form auto-expanding instead of needing a click, since
    // that's the only thing left once Log In/Guest are both ruled out there.
    // (The create-account submit button's centering used to be gated the
    // same way, account.html-only -- now applies on both pages, see
    // #checkout-account-create-submit-btn in css/checkout.css.)
    const hideGuestOption = !!options.hideGuestOption;

    container.innerHTML = accountGateMarkup();
    if (global.MonarkI18n) global.MonarkI18n.apply(container);
    // Generic per-page styling hook (css/checkout.css) for the handful of
    // spots where the two pages still deliberately diverge in LAYOUT even
    // though they share this exact markup -- e.g. which buttons get
    // centered (.checkout-account-email-actions) -- rather than a growing
    // pile of one-off boolean options each gating a single CSS rule the way
    // hideGuestOption/centerCreateButton used to. Log In/Forgot password
    // used to be one such divergence (account.html centered them as one
    // flex group; checkout.html centered Log In independently) -- no longer
    // -- both pages now use checkout.html's original, simpler treatment, see
    // css/checkout.css's own comment on #checkout-account-login-submit-btn.
    container.classList.add(hideGuestOption ? 'account-gate-page-account' : 'account-gate-page-checkout');

    const statusEl = container.querySelector('#checkout-account-status');
    const statusText = container.querySelector('#checkout-account-status-text');
    const changeBtn = container.querySelector('#checkout-account-change-btn');
    const guestUpgradeBtn = container.querySelector('#checkout-account-guest-upgrade-btn');
    const modifyEmailBtn = container.querySelector('#checkout-account-modify-email-btn');
    const createdNote = container.querySelector('#checkout-account-created-note');
    const elsewhereNote = container.querySelector('#checkout-account-elsewhere-note');
    changeBtn.textContent = changeLabel();
    // BUG FIX: changeBtn and modifyEmailBtn used to do the exact same thing
    // (both entered the cancelable email-edit mode below) -- checkout.html
    // showed two redundant buttons for one action. changeBtn keeps a real,
    // distinct purpose on account.html (immediate logOut(), see its own
    // conditional wiring further down), so it only makes sense to show there;
    // checkout.html keeps just modifyEmailBtn, right-aligned same as before
    // (see .checkout-account-status-actions in css/checkout.css). guestUpgradeBtn
    // ("Create Account", checkout.html-only -- see its own click handler
    // below) is the reverse case: hidden here at mount, toggled per-resolve
    // based on session.isGuest instead, since guest-vs-logged-in can change
    // after mount but hideGuestOption (which page this is) can't.
    if (!hideGuestOption) changeBtn.hidden = true;

    const emailForm = container.querySelector('#checkout-account-email-form');
    const emailInput = container.querySelector('#checkout-account-email-input');
    const emailError = container.querySelector('#checkout-account-email-error');
    const emailSubmitBtn = container.querySelector('#checkout-account-email-submit-btn');
    const emailCancelBtn = container.querySelector('#checkout-account-email-cancel-btn');

    const googleDivider = container.querySelector('#checkout-account-google-divider');
    const googleBtn = container.querySelector('#checkout-account-google-btn');
    const googleError = container.querySelector('#checkout-account-google-error');
    const facebookBtn = container.querySelector('#checkout-account-facebook-btn');
    const facebookError = container.querySelector('#checkout-account-facebook-error');
    // Read (and consumed/cleared) once, right here at mount -- a
    // Google/Facebook consent-screen cancellation/failure lands back on a
    // fresh load of this same page, so mount time is the one point this page
    // ever needs to look for it. Shown further below, the first time
    // resolveSession() finds no session (the gate's normal starting point
    // anyway for anyone coming back from a failed/cancelled OAuth redirect)
    // -- then nulled out so a LATER, unrelated resolve (e.g. an explicit
    // logout) never resurfaces it. oauthProvider (see
    // OAUTH_PROVIDER_PENDING_KEY's own comment) says which of the two
    // buttons' error paragraph oauthError actually belongs to; read/cleared
    // in the same breath since it's meaningless on its own once this mount
    // has consumed it.
    let oauthError = consumeOAuthErrorFromUrl();
    const oauthProvider = sessionStorage.getItem(OAUTH_PROVIDER_PENDING_KEY);
    sessionStorage.removeItem(OAUTH_PROVIDER_PENDING_KEY);

    // Read once at mount, same timing as oauthProvider above -- a reload
    // mid-signup-verification is exactly a FRESH page load, so this is the
    // one point this instance needs to check for it. Null means no pending
    // signup is restorable right now, for any of FOUR reasons: none exists
    // at all; it already resolved (verified, abandoned via Modify Email, or
    // superseded by a real session -- see clearPendingCodeEmail()'s own
    // call sites for all three); this load is a fresh 'navigate', not a
    // reload/back-forward (BUG FIX 7, see pendingSignupEmailIsRestorable());
    // or the stored send timestamp is already past OTP_EXPIRY_MS with no
    // interaction, in which case there is nothing left worth restoring
    // anyway. The last two cases also clear every SIGNUP_OTP_* key outright
    // -- not just skip restoring it THIS load -- so a later, genuinely
    // fresh signup for the same address never trips over stale leftovers.
    // Kept in sync with SIGNUP_OTP_PENDING_EMAIL_KEY by enterCodeStep()/
    // clearPendingCodeEmail() below from here on -- never written to
    // directly anywhere else.
    let pendingCodeEmail = null;
    const storedPendingEmail = sessionStorage.getItem(SIGNUP_OTP_PENDING_EMAIL_KEY) || null;
    if (storedPendingEmail) {
      const storedSentAt = Number(sessionStorage.getItem(SIGNUP_OTP_SENT_AT_KEY) || 0);
      const stillFresh = storedSentAt && (Date.now() - storedSentAt) < OTP_EXPIRY_MS;
      if (stillFresh && pendingSignupEmailIsRestorable()) {
        pendingCodeEmail = storedPendingEmail;
      } else {
        sessionStorage.removeItem(SIGNUP_OTP_PENDING_EMAIL_KEY);
        sessionStorage.removeItem(SIGNUP_OTP_ATTEMPTS_KEY);
        sessionStorage.removeItem(SIGNUP_OTP_SENT_AT_KEY);
      }
    }

    const authBlock = container.querySelector('#checkout-account-auth');
    const authEmailEcho = container.querySelector('#checkout-account-auth-email');
    const authModifyEmailBtn = container.querySelector('#checkout-account-auth-modify-email-btn');
    const authCancelBtn = container.querySelector('#checkout-account-auth-cancel-btn');
    const emailExistsNote = container.querySelector('#checkout-account-email-exists-note');

    const loginForm = container.querySelector('#checkout-account-login-form');
    const loginPasswordInput = container.querySelector('#checkout-account-login-password');
    const loginSubmitBtn = container.querySelector('#checkout-account-login-submit-btn');
    const loginError = container.querySelector('#checkout-account-login-error');
    const forgotPasswordBtn = container.querySelector('#checkout-account-forgot-password-btn');
    const forgotPasswordStatus = container.querySelector('#checkout-account-forgot-password-status');

    const optionsWrap = container.querySelector('#checkout-account-options');
    const guestBtn = container.querySelector('#checkout-account-guest-btn');
    const createToggle = container.querySelector('#checkout-account-create-toggle');

    const guestPasswordBlock = container.querySelector('#checkout-account-guest-password-block');
    const guestPasswordForm = container.querySelector('#checkout-account-guest-password-form');
    const guestPasswordInput = container.querySelector('#checkout-account-guest-password-input');
    const guestPasswordError = container.querySelector('#checkout-account-guest-password-error');
    const guestPasswordSubmitBtn = container.querySelector('#checkout-account-guest-password-submit-btn');
    const guestPasswordSkipBtn = container.querySelector('#checkout-account-guest-password-skip-btn');

    const createForm = container.querySelector('#checkout-account-create-form');
    const createFirstNameInput = container.querySelector('#checkout-account-create-firstname');
    const createLastNameInput = container.querySelector('#checkout-account-create-lastname');
    const createPasswordInput = container.querySelector('#checkout-account-create-password');
    const createConfirmInput = container.querySelector('#checkout-account-create-confirm');
    const createMarketingCheckbox = container.querySelector('#checkout-account-create-marketing');
    const createError = container.querySelector('#checkout-account-create-error');
    const createSubmitBtn = container.querySelector('#checkout-account-create-submit-btn');

    const codeBlock = container.querySelector('#checkout-account-code');
    const codeIntro = container.querySelector('#checkout-account-code-intro');
    const codeForm = container.querySelector('#checkout-account-code-form');
    const codeBoxes = Array.from(container.querySelectorAll('.checkout-account-code-box'));
    const codeStatus = container.querySelector('#checkout-account-code-status');
    const codeModifyEmailBtn = container.querySelector('#checkout-account-code-modify-email-btn');
    const codeResendBtn = container.querySelector('#checkout-account-code-resend-btn');

    // Optional at account creation (no `required`) -- asking for a phone
    // number is friction a first-time signup shouldn't need to clear just to
    // get an account; it can always be added later via Edit Profile. No
    // onChange wired here -- same as every other create-form field, an error
    // shown by the submit handler below stays until the next submit attempt
    // re-validates, rather than live-clearing on input (this form has no
    // such listener on ANY of its fields, so adding one just for phone would
    // be a one-off inconsistency, not a fix).
    const createPhoneWidget = global.MonarkPhoneInput
      ? global.MonarkPhoneInput.mount(container.querySelector('#checkout-account-create-phone'), {})
      : null;

    const recoveryBlock = container.querySelector('#checkout-account-recovery');
    const recoveryEmailLine = container.querySelector('#checkout-account-recovery-email-line');
    const recoveryForm = container.querySelector('#checkout-account-recovery-form');
    const recoveryPasswordInput = container.querySelector('#checkout-account-recovery-password');
    const recoveryPasswordRequirements = container.querySelector('#checkout-account-recovery-password-requirements');
    const recoveryConfirmInput = container.querySelector('#checkout-account-recovery-confirm');
    const recoveryConfirmError = container.querySelector('#checkout-account-recovery-confirm-error');
    const recoverySubmitBtn = container.querySelector('#checkout-account-recovery-submit-btn');
    const recoveryError = container.querySelector('#checkout-account-recovery-error');
    const recoveryCancelBtn = container.querySelector('#checkout-account-recovery-cancel-btn');

    // Show/hide toggle on every password field this gate renders -- see
    // js/password-toggle.js's own comment for why it wraps the input in
    // place instead of expecting a pre-built container (unlike
    // MonarkPhoneInput.mount() above, these inputs already exist as real
    // markup). Guarded the same way createPhoneWidget's own mount() call is,
    // in case that script failed to load.
    if (global.MonarkPasswordToggle) {
      [
        loginPasswordInput, guestPasswordInput, createPasswordInput,
        createConfirmInput, recoveryPasswordInput, recoveryConfirmInput
      ].forEach((input) => global.MonarkPasswordToggle.mount(input));
    }

    // Takes an i18n key (not raw text) -- each of these fields can show one
    // of several different messages depending on which validation/request
    // failed, so (unlike accountGateMarkup()'s single-message static fields
    // above) there's no one fixed data-i18n tag to put on the element;
    // resolving the key fresh here means the message is correct for
    // whatever language is active at the moment it's shown, same as
    // js/email-popup.js's own per-condition error messages.
    function showFieldError(el, key) {
      el.textContent = t(key);
      el.hidden = false;
    }

    // Same split-on-{placeholder} + real <strong> element approach as
    // js/checkout-page.js's own setLineWithBoldValue() (and js/reset-password.js's
    // copy of it) -- see that original's comment for why this is never done
    // via innerHTML/data-i18n-html: email is user-supplied, not this
    // project's own authored copy, and this keeps every character of the
    // value as plain text regardless of what it contains.
    function setTextWithBoldValue(el, key, varName, value) {
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

    // Used by guestPasswordForm's own submit handler below, right after
    // logIn() -- signInWithPassword() resolving only means the network call
    // itself succeeded, not that this file's module-level currentAuthUser
    // (what getSession()/findAccount() actually read) has caught up yet;
    // that only happens once the separate, async onAuthStateChange callback
    // fires and this same 'account:updated' event dispatches. Resolves as
    // soon as getSession() genuinely reflects `email` as a real session, or
    // once `timeoutMs` elapses, whichever comes first -- never rejects, so a
    // caller can always proceed afterward (worst case: pre-fill finds
    // nothing yet, same as if this wait didn't exist at all, just without
    // the near-guaranteed race the immediate version had).
    function waitForRealSession(email, timeoutMs) {
      const matches = () => {
        const session = getSession();
        return !!session && !session.isGuest && session.email.toLowerCase() === email.toLowerCase();
      };
      if (matches()) return Promise.resolve();
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          document.removeEventListener('account:updated', onUpdate);
          clearTimeout(timer);
          resolve();
        };
        const onUpdate = () => { if (matches()) finish(); };
        document.addEventListener('account:updated', onUpdate);
        const timer = setTimeout(finish, timeoutMs);
      });
    }

    // Delegates to the single canonical email-format check (js/email-popup.js,
    // loaded on every page that mounts this gate -- see that file's own
    // comment on window.MonarkValidateEmail for the full reasoning and what
    // it does/doesn't check). Falls back to a bare "has @ and a dot" shape
    // only in the unexpected case that script hasn't loaded, rather than
    // hard-failing every email as invalid.
    function isPlausibleEmail(value) {
      return window.MonarkValidateEmail ? window.MonarkValidateEmail(value) : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    }

    // 8+ characters, at least one letter, one number, and one special
    // character -- a floor, not a real strength policy. Supabase's own
    // server-side minimum (6 chars by default) is looser than this, so this
    // client-side check is always the binding one in practice. Special-char
    // set is every standard keyboard symbol (not exotic Unicode) -- kept in
    // one place here so the live checklist below, this check, and
    // account-page.js's own identical copy (its Edit Profile password-change
    // field, which reuses the same rule/message but has no checklist of its
    // own, out of this feature's scope) can't drift out of sync with each
    // other or with the accountGate.passwordHint/passwordReqSpecial wording.
    const PASSWORD_SPECIAL_CHARS_RE = /[!@#$%&*_+=.,;:?/\\|(){}[\]<>~`'"^-]/;
    function isValidPassword(value) {
      return value.length >= 8 && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && PASSWORD_SPECIAL_CHARS_RE.test(value);
    }

    // Live requirements checklist -- shared by the create-account form AND
    // the recovery step's own "New Password" field (previously create-form
    // only, hardcoded to that form's own inputs -- parameterized now that a
    // second field needs the identical checklist behavior, rather than a
    // second copy of this same function drifting from this one). Each
    // item's met/unmet state is just isValidPassword()'s own four
    // conditions checked individually instead of combined, so the user sees
    // exactly which ones are still missing instead of one all-or-nothing
    // pass/fail. ○/✓ glyphs (not color alone) so the state doesn't rely on
    // color perception either.
    const createPasswordRequirements = container.querySelector('#checkout-account-create-password-requirements');
    const PASSWORD_REQUIREMENT_CHECKS = {
      length: (value) => value.length >= 8,
      letter: (value) => /[A-Za-z]/.test(value),
      number: (value) => /[0-9]/.test(value),
      special: (value) => PASSWORD_SPECIAL_CHARS_RE.test(value)
    };
    function updatePasswordRequirements(inputEl, listEl) {
      if (!listEl) return;
      const value = inputEl.value;
      Object.keys(PASSWORD_REQUIREMENT_CHECKS).forEach((key) => {
        const item = listEl.querySelector(`[data-requirement="${key}"]`);
        if (!item) return;
        const met = PASSWORD_REQUIREMENT_CHECKS[key](value);
        item.classList.toggle('password-requirement-met', met);
        const icon = item.querySelector('.password-requirement-icon');
        if (icon) icon.textContent = met ? '✓' : '○';
      });
    }
    createPasswordInput.addEventListener('input', () => updatePasswordRequirements(createPasswordInput, createPasswordRequirements));

    // Live match-gating for the recovery step's New Password + Confirm
    // Password pair -- same "disable Set Password until both fields are
    // valid AND matching" pattern reset-password.html's own former confirm
    // field used (that page no longer has a form at all, see its own header
    // comment) -- ported here as the form's new home rather than
    // reimplemented from scratch. Unlike the create-account form's own
    // confirm field (checked only on submit, via createError below), this
    // gates the button itself: the customer only ever reaches this step via
    // a real recovery session, so there's no "wrong email/already have an
    // account" branching to justify a softer, submit-time-only check here.
    function updateRecoverySubmitState() {
      const password = recoveryPasswordInput.value;
      const confirm = recoveryConfirmInput.value;
      const matches = confirm.length > 0 && password === confirm;
      const showMismatch = confirm.length > 0 && !matches;
      recoveryConfirmError.hidden = !showMismatch;
      if (showMismatch) recoveryConfirmError.textContent = t('accountGate.errorPasswordMismatch');
      recoverySubmitBtn.disabled = !(isValidPassword(password) && matches);
    }
    recoveryPasswordInput.addEventListener('input', () => {
      updatePasswordRequirements(recoveryPasswordInput, recoveryPasswordRequirements);
      updateRecoverySubmitState();
    });
    recoveryConfirmInput.addEventListener('input', updateRecoverySubmitState);

    // Set by the email-form submit handler below, right after the
    // check-email-exists lookup resolves -- read here to decide which of the
    // auth step's options are actually reachable. Reset to false whenever the
    // gate leaves the auth step, so a stale result never leaks into the next
    // email typed.
    let emailAlreadyExists = false;

    // BUG FIX: loginForm (Log In + Forgot password, both live inside it) used
    // to stay visible whenever the email didn't exist, on BOTH pages -- only
    // right for the exists=true case (there, Log In is genuinely the one
    // correct action, on either page). A new email should never offer Log
    // In: checkout.html's own live testing showed "Se connecter"/"Mot de
    // passe oublie ?" still rendering for a never-used email, when only
    // Guest/Create Account should. So loginForm now hides for ANY new email,
    // not just on the hideGuestOption (account.html) page.
    //
    // account.html goes one step further: once Log In AND Guest are both
    // ruled out (hideGuestOption), Create Account is the only thing left --
    // no reason to make the user click "Create an account instead" first, so
    // createToggle is skipped there and the create-account fields themselves
    // are shown immediately (see the createForm.hidden line below).
    // checkout.html's new-email case is otherwise untouched: Guest + the
    // Create Account toggle both still show, same as before.
    //
    // BUG FIX: guestBtn used to hide whenever emailAlreadyExists too, on the
    // theory that Guest didn't make sense once a real account already
    // existed for that email -- but a returning customer who doesn't want to
    // log in right now (or has forgotten their password and doesn't want to
    // deal with reset mid-checkout) still has every reason to check out as a
    // guest, exactly like a brand-new email can. createToggle stays gated on
    // emailAlreadyExists though ("Create an account instead" is genuinely
    // wrong once that email is already registered -- Log In is the correct
    // second action there, not Create), so this only ungates Guest, not both.
    function applyAuthOptionsVisibility() {
      emailExistsNote.hidden = !emailAlreadyExists;
      if (emailAlreadyExists) emailExistsNote.textContent = t('accountGate.emailExistsNote');
      loginForm.hidden = !emailAlreadyExists;
      guestBtn.hidden = hideGuestOption;
      createToggle.hidden = emailAlreadyExists || hideGuestOption;
      optionsWrap.hidden = guestBtn.hidden && createToggle.hidden;
      if (hideGuestOption && !emailAlreadyExists) createForm.hidden = false;
      // Re-hidden/cleared on every fresh entry into the auth step (this runs
      // right alongside resetAuthStepFields(), see emailForm's own submit
      // handler) -- guestBtn's own click handler is what actually shows this
      // (hiding loginForm/optionsWrap in its place) when emailAlreadyExists,
      // so a prompt left open from a previous email/attempt never leaks into
      // a fresh one.
      guestPasswordBlock.hidden = true;
      guestPasswordInput.value = '';
      guestPasswordError.hidden = true;
    }

    // Hides every sub-step of the gate, then reveals only the one asked for
    // (or none, once a session exists) -- avoids repeating the same
    // multi-way "hide everything else" in each handler below. Also collapses
    // the create-account form and clears its one-time pending-confirmation
    // note back shut whenever we leave the auth step entirely, so neither
    // stays open/visible if the user comes back through.
    function showStep(step) {
      emailForm.hidden = step !== 'email';
      googleDivider.hidden = step !== 'email';
      googleBtn.hidden = step !== 'email';
      // facebookBtn/facebookError don't exist in the DOM at all while
      // FACEBOOK_LOGIN_ENABLED is off (see accountGateMarkup()'s own
      // comment) -- guarded rather than toggled unconditionally.
      if (facebookBtn) facebookBtn.hidden = step !== 'email';
      // googleError/facebookError sit outside emailForm itself (so either
      // stays visible underneath its own "Continue with ..." button even
      // while the email form above it is mid-edit), so leaving this step is
      // the one thing that has to hide them explicitly -- otherwise a
      // message raised here would keep showing, orphaned, once the
      // auth/recovery step or a fully resolved session took over below it.
      if (step !== 'email') {
        googleError.hidden = true;
        if (facebookError) facebookError.hidden = true;
      }
      authBlock.hidden = step !== 'auth';
      codeBlock.hidden = step !== 'code';
      recoveryBlock.hidden = step !== 'recovery';
      if (step !== 'auth') {
        createForm.hidden = true;
      }
    }

    // Tracks the session identity resolveSession() last actually rendered
    // for, so a resolve that finds NO real change (still undefined) into
    // 'email'/back to it. undefined (not null) is the initial sentinel, so
    // the very first resolveSession() call at mount always proceeds even
    // though getSession() is null then too.
    let lastResolvedKey;

    // Same dedup purpose as lastResolvedKey above, scoped to the recovery
    // branch specifically (that branch returns before ever reaching
    // lastResolvedKey's own check, so it needed its own).
    //
    // BUG FIX: without this, every resolveSession() call while
    // isPasswordRecovery() stayed true -- not just the first -- unconditionally
    // wiped both password fields back to empty. Harmless on the OLD, single-
    // field, quick-to-refill recovery form; a real problem on this one: a
    // TOKEN_REFRESHED firing purely from Supabase's own background session
    // maintenance (nothing to do with any customer action -- see
    // onAuthStateChange's own comment on why TOKEN_REFRESHED is deliberately
    // NOT in its clear-the-marker allow-list) would still silently wipe
    // whatever the customer had already typed into New Password/Confirm
    // Password, without kicking them out of the step entirely -- confirmed
    // live via a real TOKEN_REFRESHED broadcast. Reset once resolveSession()
    // actually leaves recovery mode (not on every call) so a genuinely LATER
    // recovery attempt still renders fresh.
    let recoveryRendered = false;

    // Set by changeBtn/modifyEmailBtn's click handlers (see
    // enterEmailEditMode() below) to whatever getSession() reported right
    // before they forced the UI to the email step -- the exact state
    // emailCancelBtn restores if the user backs out instead of finishing the
    // edit. null whenever there's nothing to cancel back to (a genuinely
    // fresh email step, or after Cancel/a completed edit already consumed
    // it).
    let previousSession = null;

    function resolveSession() {
      // BUG FIX: an unconfirmed signup's code step (pendingCodeEmail) used
      // to only be checked once getSession() already came back empty --
      // which meant ANY session resolving at all (a stale one left over
      // from before this signup attempt started, a cross-tab broadcast for
      // a totally unrelated account, or simply Supabase's own background
      // TOKEN_REFRESHED/SIGNED_IN re-firing on tab focus, confirmed live via
      // supabase-js's _onVisibilityChanged()) silently abandoned the code
      // step and jumped the customer straight to "logged in as X" -- often
      // the exact moment they switched back from their mail app/tab to type
      // the code they just read. Checked here, FIRST, unconditionally: a
      // pending signup verification now wins over password recovery, over
      // every session state below, and over every OTHER reason this
      // function gets re-invoked (visibilitychange/pageshow/bfcache
      // restores all funnel through the very same 'account:updated'
      // listener this resolves from). codeStepActive (set by enterCodeStep(),
      // cleared only by clearPendingCodeEmail()) guards against ever
      // rebuilding the step a second time while it's already showing --
      // rebuilding it would call clearCodeBoxes() and wipe whatever digits
      // the customer already typed, which is exactly the "keep the typed
      // digits across a tab switch" requirement this whole check exists for.
      if (pendingCodeEmail) {
        if (!codeStepActive) enterCodeStep(pendingCodeEmail, false);
        return;
      }
      // Checked first, ahead of getSession() -- a password-recovery link
      // grants a real (temporary) Supabase session, so getSession() would
      // otherwise report this as a normal logged-in state and skip straight
      // past the "set a new password" step entirely.
      if (isPasswordRecovery()) {
        if (!recoveryRendered) {
          recoveryRendered = true;
          statusEl.hidden = true;
          showStep('recovery');
          recoveryPasswordInput.value = '';
          recoveryConfirmInput.value = '';
          recoveryError.hidden = true;
          recoveryConfirmError.hidden = true;
          updatePasswordRequirements(recoveryPasswordInput, recoveryPasswordRequirements);
          updateRecoverySubmitState();
        }
        // Independent of recoveryRendered's own one-time guard above --
        // keeps correcting itself across a later TOKEN_REFRESHED without
        // re-touching anything the customer may have already typed.
        // getSession() (not a separate lookup) -- a recovery session is a
        // real session, currentAuthUser is already set from it by the time
        // resolveSession() runs (same onAuthStateChange callback, always
        // synchronously before notifySessionChange()'s own 'account:updated'
        // reaches this listener).
        const recoverySession = getSession();
        if (recoverySession && !recoverySession.isGuest) {
          // One combined sentence ("Choisissez un nouveau mot de passe pour
          // votre compte : {email}.") rather than two separate lines --
          // this used to be reset-password.html's own intro ("Choisissez un
          // nouveau mot de passe pour votre compte.") plus a second line
          // just for the email, back when that page had the form itself.
          setTextWithBoldValue(recoveryEmailLine, 'accountGate.setNewPasswordIntro', 'email', recoverySession.email);
        }
        return;
      }
      // Captured before clearing, so a resolve that's JUST NOW leaving the
      // recovery step (recoveryCancelBtn's logOut(), or completing
      // setNewPassword()) can force its way past resolvedKey's own dedup
      // check just below.
      const leavingRecovery = recoveryRendered;
      recoveryRendered = false;
      const session = getSession();
      const resolvedKey = session ? session.email + '|' + session.isGuest : null;
      // BUG FIX: 'account:updated' fires for every auth-state change,
      // including Supabase's async INITIAL_SESSION hydration confirming
      // "still no session" -- with no dedup, that event landing while the
      // user had already submitted their email and was mid-choice between
      // Log In/Guest/Create (still no *real* session either way) reset the
      // whole gate back to the email step out from under them. Skipping a
      // resolve that finds no actual change from last time preserves
      // whatever step the user is actively in.
      //
      // BUG FIX: that same dedup silently no-op'd the recovery step's OWN
      // exit, specifically when it resolves back to the exact same
      // resolvedKey it had going IN (both "null" -- no session either
      // side -- is the common case: recoveryCancelBtn's logOut() lands here
      // with no session, same as the very first mount before any recovery
      // ever started). lastResolvedKey has no memory of "recovery was the
      // visible step a moment ago," so it saw no change and left the
      // recovery form on screen despite the session/markers underneath it
      // already being fully cleared -- confirmed via a real Cancel-button
      // test. leavingRecovery forces exactly one re-render through in that
      // case, without touching the dedup for any other resolve.
      if (!leavingRecovery && resolvedKey === lastResolvedKey) return;
      lastResolvedKey = resolvedKey;
      if (!session) {
        // pendingCodeEmail is already handled, unconditionally, at the very
        // top of this function now -- nothing left to check here for it.
        statusEl.hidden = true;
        showStep('email');
        emailInput.value = '';
        emailError.hidden = true;
        createdNote.hidden = true;
        emailAlreadyExists = false;
        previousSession = null;
        emailCancelBtn.hidden = true;
        authCancelBtn.hidden = true;
        if (oauthError) {
          // FACEBOOK_LOGIN_ENABLED-gated too: with the button hidden/unclickable
          // there's no live way for oauthProvider to actually be 'facebook'
          // here, but gating on both means this can never try to target the
          // facebookError paragraph that doesn't exist in the DOM while it's off.
          const isFacebook = FACEBOOK_LOGIN_ENABLED && oauthProvider === 'facebook';
          const targetError = isFacebook ? facebookError : googleError;
          const otherError = isFacebook ? googleError : facebookError;
          // Facebook (unlike Google) lets the user deny sharing their email
          // on the consent screen while still approving the login itself --
          // Supabase then fails this exact same `error` redirect with an
          // error_description naming the missing email, rather than a
          // distinct error_code of its own (see signInWithFacebook()'s own
          // comment), so that's the one case pattern-matched here instead of
          // branching on errorCode alone.
          const noEmail = isFacebook && /email/i.test(oauthError.errorDescription || '');
          targetError.textContent = t(noEmail
            ? 'accountGate.errorFacebookNoEmail'
            : oauthError.errorCode === 'access_denied'
              ? (isFacebook ? 'accountGate.errorFacebookCancelled' : 'accountGate.errorGoogleCancelled')
              : (isFacebook ? 'accountGate.errorFacebookSignIn' : 'accountGate.errorGoogleSignIn'));
          targetError.hidden = false;
          if (otherError) otherError.hidden = true;
          oauthError = null;
        } else {
          googleError.hidden = true;
          if (facebookError) facebookError.hidden = true;
        }
        if (options.onUnresolved) options.onUnresolved();
        return;
      }
      // pendingCodeEmail (and therefore clearing it) is handled entirely by
      // the unconditional check at the very top of this function now --
      // this point is never reached while a signup verification is still
      // pending.
      statusText.textContent = statusLabel(session);
      statusEl.hidden = false;
      showStep(null);
      // checkout.html only (hideGuestOption false) -- account.html has its
      // own separate, pre-existing guest-to-create-account shortcut (see
      // that page's own guestCreateBtn, in its order-history empty state),
      // so this would just be a second, redundant way to do the same thing
      // there. Re-evaluated on every resolve (not just at mount, unlike
      // changeBtn's hiding above) since guest-vs-logged-in status can change
      // session to session, where hideGuestOption itself never does.
      guestUpgradeBtn.hidden = hideGuestOption || !session.isGuest;
      // previousSession is only ever non-null here in two cases: Cancel
      // (which already nulled it out itself before calling resolveSession(),
      // so this is always false for that path -- exactly right, Cancel
      // shouldn't look like an identity change to the caller) or a
      // successfully completed edit (enterEmailEditMode() set it, and
      // nothing since has touched it). identityChanged tells the caller
      // whether the resolved session is for a DIFFERENT email/guest-status
      // than whatever was showing right before changeBtn/modifyEmailBtn was
      // clicked -- checkout.html uses this to reset its own Shipping/Payment
      // accordion progress specifically when the account actually changed
      // (see its own onResolved), not on every resolution and not on Cancel.
      const identityChanged = !!previousSession
        && (previousSession.email !== session.email || previousSession.isGuest !== session.isGuest);
      previousSession = null;
      if (options.onResolved) options.onResolved(session, { identityChanged });
    }

    // Shared prep for entering the auth step with a fresh candidate email --
    // clears every stateful field a PREVIOUS attempt could have left behind
    // (typed password, name/marketing choices from an abandoned create-form
    // fill-in, etc.) so none of it leaks into this one. Used by the normal
    // email-form submit below and guestUpgradeBtn's shortcut further down
    // (which already knows the email and skips typing/re-checking it),
    // rather than duplicating this block in both.
    function resetAuthStepFields(email) {
      authEmailEcho.textContent = email;
      loginPasswordInput.value = '';
      loginError.hidden = true;
      forgotPasswordStatus.hidden = true;
      createFirstNameInput.value = '';
      createLastNameInput.value = '';
      createPasswordInput.value = '';
      createConfirmInput.value = '';
      updatePasswordRequirements(createPasswordInput, createPasswordRequirements);
      if (createPhoneWidget) createPhoneWidget.setValue({ number: '', country: 'FR' });
      // Checked by default every time this step is (re)shown, matching
      // account.html's own marketing toggle default (see that page's
      // marketingToggle.checked = acc.marketingOptIn !== false) -- opting in
      // is the default state, not something the user has to actively choose.
      if (createMarketingCheckbox) createMarketingCheckbox.checked = true;
      createError.hidden = true;
    }

    // ---- Email-code (OTP) step -- see checkout-account-code's own markup
    // comment above for the overall shape. Everything below (the six boxes'
    // input/keydown/paste wiring, the resend cooldown, the 3-attempt
    // lockout, enterCodeStep() itself) lives in this closure for the same
    // reason resetAuthStepFields()/showFieldError() above do: it needs
    // direct access to this mounted instance's own DOM nodes, and there's
    // only ever one code step per gate.

    // True from the moment enterCodeStep() first renders the step until
    // clearPendingCodeEmail() tears it back down -- resolveSession()'s own
    // top-of-function pendingCodeEmail check (see that comment) reads this
    // to tell "already showing, leave it alone" apart from "first time,
    // build it" -- rebuilding on every re-resolve (a tab switch, a
    // TOKEN_REFRESHED firing in the background) would wipe whatever digits
    // the customer already typed.
    let codeStepActive = false;

    const MAX_CODE_ATTEMPTS = 3;
    function getAttemptsUsed() {
      return Number(sessionStorage.getItem(SIGNUP_OTP_ATTEMPTS_KEY) || 0);
    }
    function setAttemptsUsed(n) {
      sessionStorage.setItem(SIGNUP_OTP_ATTEMPTS_KEY, String(n));
    }
    function resetAttempts() {
      sessionStorage.removeItem(SIGNUP_OTP_ATTEMPTS_KEY);
    }

    // The cooldown is computed FROM the real send timestamp on every
    // render, never counted down from a fixed value held only in memory --
    // see SIGNUP_OTP_SENT_AT_KEY's own comment for why (a reload
    // mid-cooldown needs the REAL remaining time, not a fresh
    // RESEND_COOLDOWN_SECONDS). RESEND_COOLDOWN_SECONDS itself is declared
    // at module scope (top of this file) -- parseRetrySeconds()/
    // rateLimitMessageKey() there need it too, for the same cooldown.
    function recordSendTimestamp() {
      sessionStorage.setItem(SIGNUP_OTP_SENT_AT_KEY, String(Date.now()));
    }
    function computeResendRemaining() {
      const sentAt = Number(sessionStorage.getItem(SIGNUP_OTP_SENT_AT_KEY) || 0);
      if (!sentAt) return 0;
      const elapsedSeconds = Math.floor((Date.now() - sentAt) / 1000);
      return Math.max(0, RESEND_COOLDOWN_SECONDS - elapsedSeconds);
    }

    function getCodeValue() {
      return codeBoxes.map((b) => b.value).join('');
    }
    function clearCodeBoxes() {
      codeBoxes.forEach((b) => { b.value = ''; });
    }
    function focusCodeBox(i) {
      const box = codeBoxes[i];
      if (box) box.focus();
    }
    // "Focus goes to the first empty box" -- the honest version of a bare
    // focusCodeBox(0): after a failed attempt the boxes are already cleared
    // before this runs, so in practice box 0 is always the first empty one,
    // but this is what actually guarantees that rather than assuming it.
    function focusFirstEmptyBox() {
      const idx = codeBoxes.findIndex((b) => !b.value);
      focusCodeBox(idx === -1 ? 0 : idx);
    }

    // Single shared status line for the whole step -- every message it
    // ever shows (wrong/truly-expired code, attempts remaining, locked-out,
    // rate limit, network error, a resend success, the "wasn't confirmed
    // yet" notice) goes through here, never a separate error paragraph and
    // a separate success one. kind picks the promo-message colour variant
    // ('error'/'success'); omit it for a neutral note. Deliberately NEVER
    // called just because a fresh code went out (BUG FIX 3) -- the step
    // shows nothing at all here until an actual failed attempt, a real
    // expiry, or an explicit resend/notice has something to say.
    function showCodeStatus(key, vars, kind) {
      codeStatus.textContent = t(key, vars);
      codeStatus.className = 'promo-message' + (kind ? ' promo-message-' + kind : '');
      codeStatus.hidden = false;
    }
    function hideCodeStatus() {
      codeStatus.hidden = true;
      codeStatus.textContent = '';
    }

    // Same split-on-{placeholder} + real element approach as
    // setTextWithBoldValue() above, but wraps the dynamic part in a plain
    // <span> (not <strong>) carrying its own masked-email styling class
    // instead of bold emphasis -- the one visual treatment this particular
    // spot needs. `maskedEmail` is already the masked form (maskEmailForDisplay())
    // by the time this is called -- the real address is never passed here.
    function setTextWithMaskedEmail(el, key, maskedEmail) {
      const template = t(key);
      const placeholder = '{email}';
      const idx = template.indexOf(placeholder);
      el.textContent = '';
      if (idx === -1) {
        el.textContent = template;
        return;
      }
      const span = document.createElement('span');
      span.className = 'checkout-account-code-masked-email';
      span.id = 'checkout-account-code-email';
      span.textContent = maskedEmail;
      el.append(
        document.createTextNode(template.slice(0, idx)),
        span,
        document.createTextNode(template.slice(idx + placeholder.length))
      );
    }

    // Reflects (and, if the lockout is already in effect, announces) the
    // 3-attempt lockout -- called on every entry into the step, including a
    // reload (SIGNUP_OTP_ATTEMPTS_KEY survives one), and right after a
    // failed verify. Returns whether it's actually locked, so callers know
    // whether they're allowed to re-enable what they just found disabled.
    // Only ever touches the boxes now -- there is no longer a submit
    // button to disable alongside them (BUG FIX 6: removed entirely, the
    // 6th digit's own auto-submit was always the real way this step is
    // submitted).
    function applyAttemptsLockState() {
      const locked = getAttemptsUsed() >= MAX_CODE_ATTEMPTS;
      codeBoxes.forEach((b) => { b.disabled = locked; });
      return locked;
    }

    // True while the status line is showing the expiry countdown message --
    // the resend countdown's own per-second tick (below) re-renders this
    // exact message every second while it's active, and switches its
    // wording the instant the cooldown reaches 0, rather than leaving a
    // stale "in Xs" sitting there once a new code is actually requestable.
    let expiredMessageActive = false;
    function renderExpiredMessage() {
      const remaining = computeResendRemaining();
      if (remaining > 0) {
        showCodeStatus('accountGate.errorCodeExpiredCooldown', { seconds: remaining }, 'error');
      } else {
        showCodeStatus('accountGate.errorCodeExpired', null, 'error');
      }
    }

    let resendTimer = null;
    let resendRemaining = 0;
    function stopResendCountdown() {
      if (resendTimer) { clearInterval(resendTimer); resendTimer = null; }
      resendRemaining = 0;
    }
    // aria-disabled alongside the native `disabled` attribute -- redundant
    // in most screen readers (disabled is already announced on its own),
    // but explicit per this feature's own requirement, and harmless either
    // way. Greyed out via CSS's own :disabled rule (muted color, no
    // underline, not-allowed cursor) -- see .checkout-account-inline-link.
    function renderResendButton() {
      const disabled = resendRemaining > 0;
      codeResendBtn.disabled = disabled;
      codeResendBtn.setAttribute('aria-disabled', String(disabled));
      codeResendBtn.textContent = disabled
        ? t('accountGate.resendCodeCountdown', { seconds: resendRemaining })
        : t('accountGate.resendCode');
    }
    // (Re)starts the cooldown display from whatever SIGNUP_OTP_SENT_AT_KEY
    // actually says right now -- the one function both a fresh send and a
    // reload-recovery entry call into, so neither path can drift from the
    // other's idea of how much time is actually left.
    function syncResendCountdown() {
      stopResendCountdown();
      resendRemaining = computeResendRemaining();
      renderResendButton();
      if (expiredMessageActive) renderExpiredMessage();
      if (resendRemaining > 0) {
        resendTimer = setInterval(() => {
          resendRemaining = computeResendRemaining();
          renderResendButton();
          if (expiredMessageActive) renderExpiredMessage();
          if (resendRemaining <= 0) stopResendCountdown();
        }, 1000);
      }
    }

    // Overlays a plain countdown ON the resend button for exactly `seconds`
    // -- used whenever Supabase itself just refused a resend (point 4: a
    // rate-limited resendSignupOtp(), with or without a code actually going
    // out), so the button reflects the REAL wait Supabase just reported
    // instead of either the sentAt-derived cooldown (which already read 0,
    // or this button would never have been clickable) or a naive immediate
    // re-enable. Deliberately independent of SIGNUP_OTP_SENT_AT_KEY/
    // computeResendRemaining() -- no new code necessarily went out here, so
    // there's no new "sent at" moment to anchor a normal cooldown to.
    function startExternalResendCooldown(seconds) {
      stopResendCountdown();
      resendRemaining = Math.max(0, Math.round(seconds));
      renderResendButton();
      if (resendRemaining > 0) {
        resendTimer = setInterval(() => {
          resendRemaining -= 1;
          renderResendButton();
          if (resendRemaining <= 0) stopResendCountdown();
        }, 1000);
      }
    }

    // Shared by the paste handler and the input handler's own multi-char
    // branch below (see that handler's comment on why a single box can
    // receive more than one character at once) -- distributes `raw`'s
    // digits across the six boxes from index 0, same semantics either way:
    // "the full code landed somewhere, fill the boxes with it."
    function fillCode(raw) {
      const digits = String(raw || '').replace(/\D/g, '').slice(0, codeBoxes.length);
      if (!digits) return;
      codeBoxes.forEach((b, idx) => { b.value = digits[idx] || ''; });
      hideCodeStatus();
      focusCodeBox(Math.min(digits.length, codeBoxes.length - 1));
      if (digits.length === codeBoxes.length) codeForm.requestSubmit();
    }

    // The only place SIGNUP_OTP_PENDING_EMAIL_KEY/pendingCodeEmail (and the
    // attempts/send-timestamp markers riding alongside it) are ever
    // cleared -- keeps all of it in sync, same "one function owns this
    // whole group" pattern as setRecoveryPending() at the top of this file.
    // Called on a successful verify and right before Modify Email backs out
    // of the step; resolveSession()'s own top-of-function check then simply
    // stops finding pendingCodeEmail set on its very next call, for every
    // other way this tab's session could resolve afterward.
    function clearPendingCodeEmail() {
      pendingCodeEmail = null;
      codeStepActive = false;
      expiredMessageActive = false;
      stopResendCountdown();
      sessionStorage.removeItem(SIGNUP_OTP_PENDING_EMAIL_KEY);
      sessionStorage.removeItem(SIGNUP_OTP_ATTEMPTS_KEY);
      sessionStorage.removeItem(SIGNUP_OTP_SENT_AT_KEY);
    }

    // Enters (or re-enters, on a fresh page load -- see resolveSession()'s
    // own pendingCodeEmail check) the code step for `email`. `fresh` is true
    // only right after an actual send just went out -- createForm's own
    // submit triggering signUp(), loginForm's own email_not_confirmed
    // handling triggering resend(), or codeResendBtn itself (which calls
    // this indirectly via syncResendCountdown(), not through here) -- that's
    // the one case this should record a new send timestamp, reset the
    // attempts counter, and clear the boxes. A reload recovery (fresh:
    // false) does none of that: the real remaining cooldown and attempts
    // count are already sitting in sessionStorage from before the reload.
    function enterCodeStep(email, fresh) {
      pendingCodeEmail = email;
      codeStepActive = true;
      sessionStorage.setItem(SIGNUP_OTP_PENDING_EMAIL_KEY, email);
      statusEl.hidden = true;
      showStep('code');
      setTextWithMaskedEmail(codeIntro, 'accountGate.codeHeading', maskEmailForDisplay(email));
      expiredMessageActive = false;
      hideCodeStatus();
      if (fresh) {
        recordSendTimestamp();
        resetAttempts();
        clearCodeBoxes();
      }
      const locked = applyAttemptsLockState();
      if (locked) showCodeStatus('accountGate.errorTooManyAttempts', null, 'error');
      syncResendCountdown();
      // Same one-frame defer as emailForm's own submit handler further down
      // (see its comment) -- showStep('code') just unhid this field in the
      // same tick, and focusing it before the browser has laid out/painted
      // the change can silently no-op on some engines.
      requestAnimationFrame(() => focusFirstEmptyBox());
    }

    // POINT 4: shared by loginForm's own submit handler and
    // guestPasswordForm's below -- both land here the instant logIn()
    // reports 'not-confirmed' (an account that signed up but never
    // finished the code step, see that function's own comment). Used to
    // just fail back to the password form on ANY resendSignupOtp() failure,
    // including a rate limit -- but a rate limit here almost always means a
    // real code is already sitting in the customer's inbox (the original
    // signUp() send, or an earlier resend), so this now treats it the same
    // as a successful resend: straight to the code step, never stranded on
    // the password form with a flat "too many attempts" that gives no way
    // to actually continue. Returns true once the customer's been moved to
    // the code step either way; false only for a genuine network/unknown
    // failure, which the caller still shows on its own password form (no
    // code step to send them to -- resendSignupOtp() never even reached
    // Supabase, or Supabase itself errored for an unrelated reason).
    async function handleUnconfirmedLogin(email) {
      const resendResult = await resendSignupOtp(email);
      if (resendResult.ok) {
        enterCodeStep(email, true);
        showCodeStatus('accountGate.emailNotConfirmedResent', null, 'info');
        return true;
      }
      if (resendResult.error === 'rate-limited') {
        const seconds = resendResult.retryAfterSeconds || RESEND_COOLDOWN_SECONDS;
        enterCodeStep(email, false);
        // No new code actually went out, but a real one almost certainly
        // already exists (that's exactly why Supabase's own throttle just
        // tripped) -- seeds a timestamp only if this tab has no idea when
        // it was sent, so BUG FIX 3's own expiry math (codeForm's own
        // submit handler) has something sane to measure against instead of
        // reading 0 and calling a perfectly valid code "expired" on the
        // very first wrong digit.
        if (!sessionStorage.getItem(SIGNUP_OTP_SENT_AT_KEY)) recordSendTimestamp();
        startExternalResendCooldown(seconds);
        // Skipped while already locked out from a previous attempt (rare,
        // but real: enterCodeStep() above already showed and left the
        // lockout message/disabled boxes in place) -- this note would
        // otherwise silently paper over that more important one.
        if (getAttemptsUsed() < MAX_CODE_ATTEMPTS) {
          showCodeStatus('accountGate.codeAlreadySentRetryIn', { seconds }, 'info');
        }
        return true;
      }
      return false;
    }

    codeBoxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        const digitsOnly = box.value.replace(/\D/g, '');
        if (digitsOnly.length > 1) {
          // A multi-character value landed in this ONE box in a single
          // tick -- either a pasted code some mobile browsers deliver here
          // before the dedicated 'paste' listener below ever fires, or
          // iOS/Android's own "code from Mail" QuickType suggestion (the
          // same one autocomplete="one-time-code" on box 0 is there to
          // trigger) inserting the whole 6-digit code at once. Treated
          // exactly like a paste of the full code, not a single keystroke.
          fillCode(digitsOnly);
          return;
        }
        box.value = digitsOnly;
        hideCodeStatus();
        if (box.value && i < codeBoxes.length - 1) {
          focusCodeBox(i + 1);
        } else if (box.value && getCodeValue().length === codeBoxes.length) {
          codeForm.requestSubmit();
        }
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !box.value && i > 0) {
          e.preventDefault();
          codeBoxes[i - 1].value = '';
          focusCodeBox(i - 1);
        } else if (e.key === 'ArrowLeft' && i > 0) {
          e.preventDefault();
          focusCodeBox(i - 1);
        } else if (e.key === 'ArrowRight' && i < codeBoxes.length - 1) {
          e.preventDefault();
          focusCodeBox(i + 1);
        }
      });
      box.addEventListener('paste', (e) => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (!/\d/.test(text)) return;
        e.preventDefault();
        fillCode(text);
      });
    });

    codeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = pendingCodeEmail;
      if (!email || getAttemptsUsed() >= MAX_CODE_ATTEMPTS) return;
      const code = getCodeValue();
      if (code.length !== codeBoxes.length) {
        showCodeStatus('accountGate.errorCodeIncomplete', null, 'error');
        return;
      }
      expiredMessageActive = false;
      hideCodeStatus();
      // The one remaining "loading state" this step has -- no submit
      // button to disable alongside the boxes any more (see
      // applyAttemptsLockState()'s own comment), just the boxes themselves
      // going inert/dimmed for the duration of the await below.
      codeBoxes.forEach((b) => { b.disabled = true; });
      try {
        const result = await verifySignupOtp(email, code);
        if (!result.ok) {
          if (result.error === 'token-invalid') {
            // BUG FIX 3: Supabase returns the exact same "token-invalid"
            // result for a wrong code AND a genuinely expired one (see
            // verifySignupOtp()'s own comment) -- this is the one place
            // that actually tells them apart, using the REAL elapsed time
            // since the code was sent (not Supabase's ambiguous wording).
            // This is also why the expired message could never correctly
            // appear moments after a fresh send before this fix: a wrong
            // digit typed seconds after signing up used to be misread as
            // "expired" purely because Supabase's shared error string
            // happens to contain that word.
            const sentAt = Number(sessionStorage.getItem(SIGNUP_OTP_SENT_AT_KEY) || 0);
            const trulyExpired = !sentAt || (Date.now() - sentAt) >= OTP_EXPIRY_MS;
            if (trulyExpired) {
              // Never counted toward the lockout below -- an expired code
              // can't succeed no matter how many attempts are left, so
              // this is its own message/flow (the live countdown toward a
              // fresh code), not another "wrong guess."
              expiredMessageActive = true;
              renderExpiredMessage();
              codeBoxes.forEach((b) => { b.disabled = false; });
              clearCodeBoxes();
              focusFirstEmptyBox();
            } else {
              // Still within OTP_EXPIRY_MS -- a genuinely wrong code, so
              // THIS is the one failure mode that counts toward the
              // 3-attempt lockout (see MAX_CODE_ATTEMPTS's own comment);
              // rate-limited/network below never do, since neither means
              // the customer actually guessed wrong.
              const used = getAttemptsUsed() + 1;
              setAttemptsUsed(used);
              const remaining = MAX_CODE_ATTEMPTS - used;
              if (remaining > 0) {
                showCodeStatus(
                  remaining === 1 ? 'accountGate.errorCodeInvalidAttemptsOne' : 'accountGate.errorCodeInvalidAttemptsMany',
                  { remaining },
                  'error'
                );
                // Re-enabled here, BEFORE clearing/focusing -- the `finally`
                // below also does this, but only once this whole branch
                // returns, and a disabled input silently refuses focus().
                codeBoxes.forEach((b) => { b.disabled = false; });
                clearCodeBoxes();
                focusFirstEmptyBox();
              } else {
                showCodeStatus('accountGate.errorTooManyAttempts', null, 'error');
                // Left disabled deliberately -- the `finally` below only
                // re-enables when NOT locked (see its own guard), so this
                // lockout actually holds rather than being undone a line later.
              }
            }
          } else if (result.error === 'rate-limited') {
            // Digits kept -- not the customer's fault, and the exact same
            // code may well still work once Supabase's own limit clears.
            showCodeStatus('accountGate.errorRateLimited', null, 'error');
          } else if (result.error === 'network') {
            showCodeStatus('accountGate.errorNetwork', null, 'error');
          } else {
            showCodeStatus('accountGate.errorGeneric', null, 'error');
          }
          return;
        }
        clearPendingCodeEmail();
        // onAuthStateChange's own SIGNED_IN handling (top of this file)
        // already picked up the real session verifyOtp() just established
        // by the time this await resolves -- resolveSession() below just
        // needs to render it. Same "a real account creation deserves its
        // own success note" treatment as the non-OTP branch further down in
        // createForm's own submit handler.
        createdNote.textContent = t('accountGate.accountCreated');
        createdNote.hidden = false;
        resolveSession();
      } finally {
        // Only touches disabled state when NOT (now) locked out -- a
        // 3rd-failure lockout above deliberately keeps both disabled, and
        // this must never silently undo that a line later.
        if (getAttemptsUsed() < MAX_CODE_ATTEMPTS) {
          codeBoxes.forEach((b) => { b.disabled = false; });
        }
      }
    });

    codeResendBtn.addEventListener('click', async () => {
      const email = pendingCodeEmail;
      if (!email) return;
      hideCodeStatus();
      codeResendBtn.disabled = true;
      codeResendBtn.setAttribute('aria-disabled', 'true');
      const result = await resendSignupOtp(email);
      if (result.ok) {
        // "Sending a new code resets the attempts and clears the boxes" --
        // a fresh code genuinely gives the customer a clean slate, lockout
        // included.
        recordSendTimestamp();
        resetAttempts();
        clearCodeBoxes();
        expiredMessageActive = false;
        codeBoxes.forEach((b) => { b.disabled = false; });
        showCodeStatus('accountGate.resendCodeSuccess', null, 'success');
        syncResendCountdown();
        focusFirstEmptyBox();
      } else if (result.error === 'rate-limited') {
        // POINT 4: Supabase's own throttle tripped on this resend -- no new
        // code went out, but the real wait it just reported (or
        // RESEND_COOLDOWN_SECONDS, when Supabase gave no number at all --
        // the hourly-quota case) is still a real wait, so the button stays
        // disabled for it instead of going straight back to clickable (the
        // old behavior here, which just invited an immediate second
        // rate-limited retry).
        showCodeStatus(rateLimitMessageKey(result), null, 'error');
        startExternalResendCooldown(result.retryAfterSeconds || RESEND_COOLDOWN_SECONDS);
      } else {
        showCodeStatus(result.error === 'network' ? 'accountGate.errorNetwork' : 'accountGate.errorGeneric', null, 'error');
        // No send actually happened here -- nothing to cool down, so the
        // button goes right back to clickable rather than enforcing a wait
        // for a send that never left.
        codeResendBtn.disabled = false;
        codeResendBtn.setAttribute('aria-disabled', 'false');
      }
    });

    // Backs all the way out of the pending signup -- the customer typed the
    // wrong address, or just wants to restart with a different one. Clears
    // every pending marker (clearPendingCodeEmail()'s own comment) and
    // returns to the plain email step, pre-filled with the address that was
    // pending -- the "with the email prefilled" half of this link's own
    // requirement, same convenience enterEmailEditMode() already gives its
    // own Modify Email button.
    codeModifyEmailBtn.addEventListener('click', () => {
      const email = pendingCodeEmail;
      clearPendingCodeEmail();
      onEnterEditMode();
      showStep('email');
      emailInput.value = email || '';
      emailError.hidden = true;
      emailAlreadyExists = false;
      emailCancelBtn.hidden = true;
      authCancelBtn.hidden = true;
      emailInput.focus();
      emailInput.select();
    });

    // Best-effort resync for a bfcache restore specifically (BUG FIX 7) --
    // this page's own JS state (codeStepActive, pendingCodeEmail, typed
    // digits) survives a bfcache suspend/resume completely untouched,
    // since a TRUE bfcache restore never re-runs this script at all
    // (nothing tore it down to begin with) -- but a setInterval-driven
    // countdown sits paused for however long the page was suspended, so
    // without this the displayed number/message can be stale for up to a
    // second after becoming visible again. This just forces an immediate
    // resync the instant that happens instead of waiting for the next
    // natural tick.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && codeStepActive) {
        syncResendCountdown();
        if (expiredMessageActive) renderExpiredMessage();
      }
    });

    emailForm.addEventListener('submit', async (e) => {
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

      // Disabled for the round trip to check-email-exists so a slow network
      // can't let the user submit twice (e.g. two different emails racing
      // each other into authEmailEcho below).
      emailSubmitBtn.disabled = true;
      emailInput.disabled = true;
      emailAlreadyExists = await checkEmailExists(email);
      emailSubmitBtn.disabled = false;
      emailInput.disabled = false;

      resetAuthStepFields(email);
      createForm.hidden = true;
      applyAuthOptionsVisibility();
      showStep('auth');
      // Reachable via changeBtn/modifyEmailBtn -- see enterEmailEditMode()
      // -- previousSession carries over from there, so Cancel stays
      // available here too, restoring the original session in one click
      // instead of having to go back to the email step first.
      authCancelBtn.hidden = !previousSession;
      // BUG FIX: this used to fall back to createToggle.focus() when
      // loginForm was hidden -- reported live as focus/selection visibly
      // "stuck" on Create Account after just pressing Enter in the email
      // field, nothing clicked. createToggle (and guestBtn next to it) are
      // both full .cta-button-styled buttons now (see the Create Account/
      // Continue as Guest reorder), so a browser focus ring on either reads
      // as "this button is active/pressed" -- misleading when the user's
      // actual action was submitting the email step, not choosing between
      // these two. Only focus loginPasswordInput (a real field the user is
      // about to type into, not a choice) when it's actually shown; when
      // it's account.html's auto-expanded create form instead, focus its
      // first field for the same reason. Otherwise (checkout.html, new
      // email, Guest/Create Account both just choices to make) leave focus
      // alone -- the hidden email input naturally releases it to the
      // document, same as any other step change in this flow.
      // Best-effort mobile-keyboard mitigation: this focus() already fires
      // as early as this handler CAN know which field to target (only
      // resolvable after the checkEmailExists() await above resolves) --
      // there's no earlier point to move it to. On iOS Safari/some Android
      // Chrome versions, a focus() call that isn't a direct synchronous
      // continuation of the original tap's event handler often does NOT
      // reopen the on-screen keyboard, even though the element still
      // becomes document.activeElement (cursor/selection are fine, a
      // physical keyboard types into it correctly) -- a platform-level
      // restriction against unsolicited focus-stealing, not something a
      // network round trip can get back once it's genuinely intervened.
      // requestAnimationFrame here is a real (if partial) improvement for a
      // SEPARATE reason: showStep('auth') just flipped this field from
      // hidden to visible in this same tick, and calling focus() before the
      // browser has actually laid out/painted a just-unhidden element can
      // silently no-op on some engines. Deferring one frame guarantees the
      // field is genuinely focusable when this runs -- imperceptible on
      // desktop (same focus() call, ~16ms later), no new autofocus
      // behavior introduced there, so no mobile-only guard is needed.
      if (!loginForm.hidden) {
        requestAnimationFrame(() => loginPasswordInput.focus());
      } else if (!createForm.hidden) {
        requestAnimationFrame(() => createFirstNameInput.focus());
      }
    });

    // Bypasses the email form above entirely -- signInWithGoogle() is a full
    // top-level redirect (window.location.assign() inside supabase-js
    // itself) on success, so disabling the button is only ever visible for
    // the brief gap before that navigation actually happens; re-enabled in
    // the `finally` purely for the synchronous-error case (provider not
    // configured yet, network failure) where no navigation ever starts.
    googleBtn.addEventListener('click', async () => {
      googleError.hidden = true;
      googleBtn.disabled = true;
      try {
        const result = await signInWithGoogle();
        if (!result.ok) {
          googleError.textContent = t('accountGate.errorGoogleSignIn');
          googleError.hidden = false;
        }
      } finally {
        googleBtn.disabled = false;
      }
    });

    // Same shape as googleBtn's own handler just above -- see
    // signInWithFacebook()'s comment for the one real difference (the
    // no-email case, surfaced later via oauthError/oauthProvider once the
    // redirect actually lands back here, not from this synchronous call).
    // Guarded: facebookBtn is null whenever FACEBOOK_LOGIN_ENABLED is off
    // (see accountGateMarkup()'s own comment), so there's nothing to wire up.
    if (facebookBtn) {
      facebookBtn.addEventListener('click', async () => {
        facebookError.hidden = true;
        facebookBtn.disabled = true;
        try {
          const result = await signInWithFacebook();
          if (!result.ok) {
            facebookError.textContent = t('accountGate.errorFacebookSignIn');
            facebookError.hidden = false;
          }
        } finally {
          facebookBtn.disabled = false;
        }
      });
    }

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      loginError.hidden = true;
      // Single dominant field -- same disable-input-and-button pattern as
      // the email step above (emailSubmitBtn/emailInput), not just the
      // button alone. .cta-button:disabled (css/style.css) dims the button,
      // .checkout-field input:disabled (css/checkout.css) mutes the field --
      // same visible "working" feedback checkout.html's own Place Order
      // button already gave, just also covering this one input.
      loginSubmitBtn.disabled = true;
      loginPasswordInput.disabled = true;
      try {
        const email = authEmailEcho.textContent;
        const result = await logIn(email, loginPasswordInput.value);
        if (result.ok) {
          resolveSession();
        } else if (result.error === 'not-confirmed') {
          // BUG FIX: an account that signed up but never finished the code
          // step got the exact same "Incorrect password" message as a
          // genuinely wrong password here -- logIn()'s own error: 'not-
          // confirmed' (see that function's comment) is what tells the two
          // apart. handleUnconfirmedLogin() (point 4) now also moves to the
          // code step on a rate-limited resend, not just a successful one --
          // only a genuine network/unknown failure still fails back here.
          if (!(await handleUnconfirmedLogin(email))) {
            showFieldError(loginError, 'accountGate.errorGeneric');
          }
        } else {
          showFieldError(loginError, 'accountGate.errorWrongPassword');
        }
      } finally {
        loginSubmitBtn.disabled = false;
        loginPasswordInput.disabled = false;
      }
    });

    forgotPasswordBtn.addEventListener('click', async () => {
      const email = authEmailEcho.textContent;
      forgotPasswordStatus.hidden = true;
      const result = await requestPasswordReset(email);
      if (result.ok) {
        setTextWithBoldValue(forgotPasswordStatus, 'accountGate.resetPasswordSent', 'email', email);
      } else {
        forgotPasswordStatus.textContent = result.error === 'rate-limited'
          ? t('accountGate.errorRateLimited')
          : t('accountGate.resetPasswordError');
      }
      forgotPasswordStatus.className = 'promo-message ' + (result.ok ? 'promo-message-success' : 'promo-message-error');
      forgotPasswordStatus.hidden = false;
    });

    // BUG FIX: used to always continue straight to a guest session. A
    // returning customer choosing Guest for an email that already has a real
    // account has every reason to want their saved shipping info without
    // fully logging in (see checkout-account-guest-password-block's own
    // markup comment) -- offer that instead of silently starting them from a
    // blank form. A brand-new email (no account to offer credentials for)
    // still continues straight to guest exactly as before.
    guestBtn.addEventListener('click', async () => {
      if (emailAlreadyExists) {
        loginForm.hidden = true;
        optionsWrap.hidden = true;
        guestPasswordBlock.hidden = false;
        guestPasswordInput.focus();
        return;
      }
      await continueAsGuest(authEmailEcho.textContent);
      resolveSession();
    });

    // Declines the password prompt -- proceeds as a true guest with an empty
    // form, exactly like guestBtn's own original (pre-BUG-FIX) behavior.
    guestPasswordSkipBtn.addEventListener('click', async () => {
      await continueAsGuest(authEmailEcho.textContent);
      resolveSession();
    });

    guestPasswordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      guestPasswordError.hidden = true;
      guestPasswordSubmitBtn.disabled = true;
      guestPasswordInput.disabled = true;
      try {
        const email = authEmailEcho.textContent;
        const result = await logIn(email, guestPasswordInput.value);
        if (!result.ok) {
          // Same email_not_confirmed handling as loginForm's own submit
          // handler above -- an unconfirmed account has no "saved data" to
          // pre-fill from yet either way, so this sends it through the
          // exact same resend-then-code-step path rather than just failing.
          if (result.error === 'not-confirmed') {
            if (!(await handleUnconfirmedLogin(email))) {
              showFieldError(guestPasswordError, 'accountGate.errorGeneric');
            }
          } else {
            showFieldError(guestPasswordError, 'accountGate.errorWrongPassword');
          }
          return;
        }
        // logIn() succeeded -- a real session now exists just long enough to
        // pre-fill from the account's own saved data via the exact same
        // trusted path a genuine logged-in session uses (see
        // checkout-page.js's own onGuestAuthenticated option, wired to its
        // prefillShippingFromAccount()) -- then immediately reverted to a
        // plain guest session below, so the rest of checkout behaves exactly
        // like any other guest flow: no forced account-mode redirect, no
        // session left logged in as the real account.
        //
        // BUG FIX: onGuestAuthenticated used to fire immediately here --
        // but logIn()'s own signInWithPassword() resolving only means the
        // network call succeeded, not that this file's module-level
        // currentAuthUser has actually been updated yet (that only happens
        // inside the SEPARATE, async onAuthStateChange callback -- see this
        // file's own top-of-file ASYNC NOTE on getSession()'s cache). Since
        // findAccount() -- what checkout-page.js's prefillShippingFromAccount()
        // actually reads from -- refuses to resolve anything unless
        // currentAuthUser already matches the requested email (its own
        // "only ever resolves for the CURRENTLY authenticated user" guard),
        // calling onGuestAuthenticated before that lands was a real, silent
        // failure mode: the prefill callback would run, find no matching
        // currentAuthUser yet, and quietly return nothing to pre-fill.
        // waitForRealSession() below blocks on the SAME 'account:updated'
        // event getSession()'s own cache is kept current by, with a bounded
        // timeout so a pathological case (the event never fires at all)
        // can't hang this indefinitely -- prefill just runs with whatever
        // state exists once that timeout elapses instead.
        await waitForRealSession(email, 3000);
        if (options.onGuestAuthenticated) {
          await options.onGuestAuthenticated({ email, isGuest: false });
        }
        await logOut();
        await continueAsGuest(email);
        resolveSession();
      } finally {
        guestPasswordSubmitBtn.disabled = false;
        guestPasswordInput.disabled = false;
      }
    });

    createToggle.addEventListener('click', () => {
      createForm.hidden = !createForm.hidden;
      if (!createForm.hidden) createPasswordInput.focus();
    });

    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      // Checked in sequence, each with its own early return, so multiple
      // problems (e.g. a missing name AND a too-weak password) don't have one
      // silently mask another -- the user always sees whichever is wrong
      // first, and fixing it surfaces the next one rather than all failing
      // invisibly at once.
      const createFirstNameVal = createFirstNameInput.value.trim();
      const createLastNameVal = createLastNameInput.value.trim();
      if (!createFirstNameVal || !createLastNameVal) {
        showFieldError(createError, 'accountGate.errorNameRequired');
        return;
      }
      // Shared format/length check (window.MonarkValidateName, js/email-
      // popup.js) -- same one checkout.html's Shipping form and account.html's
      // Edit Profile form both use, so a name is never accepted in one place
      // and rejected in another. This form only has ONE shared error slot for
      // both fields (not per-field, unlike Shipping's), so it stays that way
      // here too rather than introducing a new error-display pattern.
      if (window.MonarkValidateName && (!window.MonarkValidateName(createFirstNameVal) || !window.MonarkValidateName(createLastNameVal))) {
        showFieldError(createError, 'accountGate.errorNameFormat');
        return;
      }
      if (!isValidPassword(createPasswordInput.value)) {
        showFieldError(createError, 'accountGate.errorPasswordWeak');
        return;
      }
      if (createPasswordInput.value !== createConfirmInput.value) {
        showFieldError(createError, 'accountGate.errorPasswordMismatch');
        return;
      }
      const phoneValue = createPhoneWidget ? createPhoneWidget.getValue() : null;
      if (createPhoneWidget && !createPhoneWidget.isValid()) {
        showFieldError(createError, phoneValue.country === 'FR' ? 'phoneInput.errorInvalidFR' : 'phoneInput.errorInvalidGeneric');
        return;
      }
      createError.hidden = true;
      const newAccountEmail = authEmailEcho.textContent;
      // Many fields on this form -- disabling every one of them individually
      // would be a lot of extra bookkeeping for marginal benefit, so this
      // matches Place Order's own structure instead (checkout.html's
      // submitBtn): just the submit button, right before the async call,
      // try/finally around it so every return path below still re-enables it.
      createSubmitBtn.disabled = true;
      try {
        // BUG FIX: a still-logged-in customer reaching this form via
        // modifyEmailBtn/guestUpgradeBtn's own cancelable edit mode (see
        // enterEmailEditMode()'s comment on why neither signs out on its
        // own) used to still have a REAL session active at this exact
        // moment -- and supabase-js attaches that session's own access
        // token as the Authorization header on every request it sends,
        // signUp() included. Supabase's server-side identity-linking logic
        // treats a signUp() call carrying an authenticated bearer token for
        // an EXISTING user as updating/linking that account rather than
        // creating a brand-new one -- which is also why it sent a Change
        // Email Address confirmation LINK instead of this project's Confirm
        // Signup OTP (confirmed as the actual cause of a real report: a
        // customer already logged in, creating a second account under a
        // different address, got a link email instead of a 6-digit code).
        // Signing out HERE, right before createAccount()'s own signUp()
        // call, removes that token entirely -- the request below now runs
        // as a clean, anonymous signup, with no old/new identity ever
        // mixed under one session.
        const existingSession = getSession();
        if (existingSession && !existingSession.isGuest) {
          await logOut();
        }
        const result = await createAccount(newAccountEmail, createPasswordInput.value, {
          firstName: createFirstNameInput.value.trim(),
          lastName: createLastNameInput.value.trim(),
          marketingOptIn: createMarketingCheckbox ? createMarketingCheckbox.checked : true,
          phone: phoneValue ? phoneValue.number : '',
          dialCode: phoneValue ? phoneValue.dialCode : '',
          country: phoneValue ? phoneValue.country : ''
        });
        if (!result.ok) {
          // BUG FIX: this used to show "account already exists" for every
          // failure reason, not just result.error === 'exists' -- so any other
          // signUp() failure (bad API key, disabled email provider, an
          // RLS/trigger error on the profiles insert, rate limiting, CORS...)
          // was misreported as a duplicate account. createAccount()'s own
          // console.error already has the real message when it's 'unknown'.
          const errorKey = result.error === 'exists' ? 'accountGate.errorAccountExists'
            // POINT 4: distinct copy for Supabase's blunter hourly quota
            // (no specific wait given at all) vs. its short, named cooldown
            // -- see rateLimitMessageKey()'s own comment.
            : result.error === 'rate-limited' ? rateLimitMessageKey(result)
            // Supabase's own server-side password policy rejecting this
            // password (see createAccount()'s own weak_password comment) --
            // reuses the exact same copy the client-side check above shows,
            // so the wording is consistent regardless of which side caught it.
            : result.error === 'weak-password' ? 'accountGate.errorPasswordWeak'
            : 'accountGate.errorGeneric';
          showFieldError(createError, errorKey);
          return;
        }
        if (result.needsEmailConfirmation) {
          // Supabase's Confirm Email setting (dashboard-side) is on, so the
          // account isn't real yet -- its "Confirm signup" email just mailed
          // a 6-digit code (see enterCodeStep()'s own markup comment).
          // Nothing to do here beyond handing off to that step: it owns its
          // own success/error messaging from here on, not createdNote.
          enterCodeStep(newAccountEmail, true);
          return;
        }
        // BUG FIX: this used to say "a confirmation email has been sent to
        // {email}" unconditionally -- leftover copy from the old localStorage
        // mock, which never actually emailed anyone. Reaching this branch (not
        // the needsEmailConfirmation one above) means Supabase already handed
        // back a real session, i.e. no confirmation step exists for this
        // signup (email confirmation is off, no SMTP configured) -- claiming
        // an email was sent here was simply false.
        createdNote.textContent = t('accountGate.accountCreated');
        createdNote.hidden = false;
        resolveSession();
      } finally {
        createSubmitBtn.disabled = false;
      }
    });

    recoveryForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      // Defensive backstop -- recoverySubmitBtn.disabled (updateRecoverySubmitState()
      // above) already keeps both of these unreachable via a normal click,
      // same "belt and suspenders" reasoning reset-password.html's own
      // former submit handler used for the identical pair of checks.
      if (!isValidPassword(recoveryPasswordInput.value)) {
        showFieldError(recoveryError, 'accountGate.errorPasswordWeak');
        return;
      }
      if (recoveryPasswordInput.value !== recoveryConfirmInput.value) {
        showFieldError(recoveryError, 'accountGate.errorPasswordMismatch');
        return;
      }
      recoveryError.hidden = true;
      recoverySubmitBtn.disabled = true;
      recoveryPasswordInput.disabled = true;
      recoveryConfirmInput.disabled = true;
      recoveryCancelBtn.disabled = true;
      try {
        const result = await setNewPassword(recoveryPasswordInput.value);
        if (result.ok) {
          resolveSession();
        } else {
          showFieldError(recoveryError, result.error === 'same-password' ? 'accountGate.errorSamePassword' : 'accountGate.errorGeneric');
        }
      } finally {
        recoverySubmitBtn.disabled = false;
        recoveryPasswordInput.disabled = false;
        recoveryConfirmInput.disabled = false;
        recoveryCancelBtn.disabled = false;
      }
    });

    // Backs all the way out of the pending recovery WITHOUT setting a new
    // password -- e.g. the customer clicked the email link out of curiosity,
    // or on the wrong device, and just wants to keep browsing normally.
    // Signs out of the temporary recovery session entirely (logOut(), not
    // just setRecoveryPending(false) on its own): a password-recovery link
    // grants a REAL, temporary Supabase session -- getSession() can't tell
    // it apart from a genuine login once isPasswordRecovery() stops gating
    // it, so merely clearing the pending marker here would silently grant
    // full account access with no new password ever set, exactly the bug
    // this whole flow exists to prevent. logOut()'s own SIGNED_OUT event
    // already clears passwordRecoveryActive/RECOVERY_UNCONFIRMED_KEY (see
    // onAuthStateChange's SIGNED_OUT branch above) -- nothing else needed
    // here beyond that and re-resolving, same "logOut() then resolveSession()"
    // pattern account-page.js's own guestLoginBtn/guestCreateBtn already use.
    // (This is now also exactly what a refresh or navigation does on its own
    // -- see the pagehide listener and INITIAL_SESSION handling near the top
    // of this file -- Cancel is just the explicit, immediate version of it.)
    recoveryCancelBtn.addEventListener('click', async () => {
      recoverySubmitBtn.disabled = true;
      recoveryPasswordInput.disabled = true;
      recoveryConfirmInput.disabled = true;
      recoveryCancelBtn.disabled = true;
      try {
        await logOut();
        resolveSession();
      } finally {
        recoverySubmitBtn.disabled = false;
        recoveryPasswordInput.disabled = false;
        recoveryConfirmInput.disabled = false;
        recoveryCancelBtn.disabled = false;
      }
    });

    // BUG FIX: modifyEmailBtn (both pages) and checkout.html's changeBtn
    // ("Modify") used to call logOut() the instant either was clicked -- for
    // a real session that signs the user all the way out (a network round
    // trip) before they've even typed a new email, and for a guest session
    // it drops the guest email from localStorage -- so backing out via
    // Cancel had nothing left to restore without asking them to re-enter
    // everything. Routed through here, nothing is torn down: this just
    // captures the still-fully-intact session (so Cancel can put it straight
    // back) and shows the email step. The actual logOut() is deferred to
    // whichever action the user actually completes -- see continueAsGuest()'s
    // own comment (near the top of this file) for why "Continue as Guest"
    // specifically still needs one (Log In/Create Account don't: Supabase's
    // signIn/signUp replace the current session on their own).
    function enterEmailEditMode() {
      previousSession = getSession();
      // BUG FIX: resolveSession()'s own dedup guard (see its "if (resolvedKey
      // === lastResolvedKey) return" comment) compares only email+isGuest --
      // it exists to swallow a SPURIOUS re-fire that lands on the exact same
      // session (e.g. Supabase's async INITIAL_SESSION hydration), not a
      // genuine, user-completed edit. But lastResolvedKey is set once by the
      // FIRST resolve and never touched again outside of cancelEmailEdit()
      // -- so re-submitting THE SAME email through this edit flow (Modify
      // Email -> retype the identical address -> Continue as Guest/Log In)
      // produced a resolvedKey identical to that stale value, and
      // resolveSession() silently returned before ever calling onResolved()
      // -- the accordion just sat there looking broken, even though nothing
      // was actually wrong with the email. A genuinely different email never
      // hit this, which is exactly why it looked like only the SAME email
      // was the broken case. Clearing it here (same as cancelEmailEdit()
      // already does for the same reason) guarantees the NEXT resolution --
      // whatever email it ends up being -- is always treated as fresh.
      lastResolvedKey = undefined;
      statusEl.hidden = true;
      onEnterEditMode();
      showStep('email');
      // Pre-filled with the current email (not cleared) -- previousSession
      // just above already has it, so there's no reason to make the user
      // retype an address they're likely only fixing a typo in. .select()
      // right after focus() highlights the whole thing so a single
      // keystroke still replaces it entirely for a full rewrite -- this
      // only runs once, here, not on every future focus of this field, so a
      // later click back into it positions the cursor normally instead of
      // re-selecting everything.
      emailInput.value = previousSession ? previousSession.email : '';
      emailInput.focus();
      emailInput.select();
      emailError.hidden = true;
      createdNote.hidden = true;
      emailAlreadyExists = false;
      emailCancelBtn.hidden = false;
      authCancelBtn.hidden = true;
    }

    // changeBtn is only ever visible on account.html now (hidden at mount on
    // checkout.html, see above -- checkout.html's own "Modify" used to be a
    // second button doing the exact same thing as modifyEmailBtn below, so
    // it was removed rather than also switched to the deferred/cancelable
    // behavior). "Log Out" is a genuinely different, immediate action from
    // "Modify Email" -- account.html keeps this as a plain logOut(), not the
    // deferred/cancelable enterEmailEditMode() modifyEmailBtn uses.
    changeBtn.addEventListener('click', async () => {
      await logOut();
      resolveSession();
    });

    // Separate from changeBtn above -- same underlying edit-mode entry, just
    // reachable under an unambiguous "Modify Email" label rather than
    // changeBtn's page-specific one (e.g. account.html's changeBtn reads
    // "Log Out", which some users might hesitate to click just to try a
    // different email).
    modifyEmailBtn.addEventListener('click', enterEmailEditMode);

    // checkout.html-only guest upgrade shortcut (see guestUpgradeBtn.hidden
    // in resolveSession() above) -- goes straight into the create-account
    // fields with the guest's own email already filled in, rather than
    // making them retype it through the plain email step + Continue +
    // Create Account choice.
    //
    // BUG FIX: this used to call logOut() immediately, the same mistake
    // enterEmailEditMode() used to make (see its own BUG FIX comment) --
    // clearing the guest session on click left nothing for Cancel to restore
    // if the user backed out of creating an account. Doesn't need an
    // explicit logOut() at all, deferred or otherwise: the guest session is
    // simply left alone here, and if createForm's own submit later succeeds,
    // onAuthStateChange's own "a real session always wins over a leftover
    // guest email" handling (top of this file) clears GUEST_KEY for free the
    // moment the new real session lands. previousSession is set the same way
    // enterEmailEditMode() sets it, so authCancelBtn below restores this
    // exact guest session with nothing lost if the user changes their mind.
    guestUpgradeBtn.addEventListener('click', () => {
      const session = getSession();
      if (!session || !session.isGuest) return;
      previousSession = session;
      statusEl.hidden = true;
      resetAuthStepFields(session.email);
      emailAlreadyExists = false;
      emailExistsNote.hidden = true;
      loginForm.hidden = true;
      guestBtn.hidden = true;
      createToggle.hidden = true;
      optionsWrap.hidden = true;
      createForm.hidden = false;
      showStep('auth');
      authCancelBtn.hidden = false;
      createFirstNameInput.focus();
    });

    // Shared by emailCancelBtn (email step) and authCancelBtn (auth step,
    // reachable via a submitted email -- enterEmailEditMode() -- or
    // guestUpgradeBtn's direct jump into the create-account fields above) --
    // both undo whatever put the gate into an editable state, only ever
    // reachable when previousSession was actually captured. Since neither
    // enterEmailEditMode() nor guestUpgradeBtn calls logOut()/continueAsGuest()
    // anymore, the underlying session was never touched: getSession() still
    // reports it exactly as before. resolveSession()'s dedup would normally
    // skip re-rendering an unchanged session (see its own BUG FIX comment),
    // which is exactly wrong here -- we DID change what's on screen even
    // though the session itself didn't move -- so this clears the dedup
    // sentinel first to force a fresh render of the still-intact session. No
    // network call, no re-entering anything.
    function cancelEmailEdit() {
      previousSession = null;
      emailCancelBtn.hidden = true;
      authCancelBtn.hidden = true;
      lastResolvedKey = undefined;
      resolveSession();
    }
    emailCancelBtn.addEventListener('click', cancelEmailEdit);
    authCancelBtn.addEventListener('click', cancelEmailEdit);

    // The auth step's own escape hatch -- reachable while a plausible email
    // has been submitted but no session exists yet (mid login/guest/create,
    // including the login-only view above when check-email-exists said the
    // typed email already has an account). Unlike changeBtn/modifyEmailBtn,
    // there's no real session to log out of here, and going through
    // resolveSession() would be a no-op: resolveSession()'s own dedup (see
    // its BUG FIX comment above) skips re-rendering when getSession() is
    // still null, which it already is at this point -- so this resets the UI
    // directly instead. previousSession (if any -- i.e. this was reached via
    // changeBtn/modifyEmailBtn rather than a genuinely fresh email step) is
    // left untouched, so Cancel is still available from here.
    authModifyEmailBtn.addEventListener('click', () => {
      onEnterEditMode();
      showStep('email');
      // Not cleared -- emailInput.value already holds whatever was
      // submitted to reach this step (resetAuthStepFields() above never
      // touches it), so it's already the right value to edit; clearing it
      // here would just be throwing away a correct pre-fill. .select()
      // highlights it so a single keystroke replaces it entirely -- same
      // one-shot (not on every focus) behavior as enterEmailEditMode()'s
      // own comment on this.
      emailError.hidden = true;
      emailAlreadyExists = false;
      emailCancelBtn.hidden = !previousSession;
      authCancelBtn.hidden = true;
      emailInput.focus();
      emailInput.select();
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
      // Same reasoning as changeBtn/statusText above -- codeResendBtn's
      // countdown label, the expiry countdown message, and the lockout
      // message are all plain textContent writes (renderResendButton()/
      // renderExpiredMessage()/showCodeStatus()), not data-i18n-tagged
      // elements, so a language switch mid-flow needs this to pick up the
      // new wording itself. Each only re-renders while its own state is
      // actually active -- codeResendBtn's static "Resend code" label and
      // every other static string on this step are already handled by
      // MonarkI18n.apply(document)'s own pass, same as every other
      // data-i18n element on this gate.
      if (resendRemaining > 0) renderResendButton();
      // codeIntro's own "Enter the code sent to {masked email}" sentence --
      // also a plain textContent/DOM write (setTextWithMaskedEmail()), not
      // data-i18n, so it needs the exact same re-render-on-switch treatment
      // while the code step is actually showing.
      if (codeStepActive && pendingCodeEmail) {
        setTextWithMaskedEmail(codeIntro, 'accountGate.codeHeading', maskEmailForDisplay(pendingCodeEmail));
      }
      if (expiredMessageActive) renderExpiredMessage();
      else if (codeStepActive && getAttemptsUsed() >= MAX_CODE_ATTEMPTS) {
        showCodeStatus('accountGate.errorTooManyAttempts', null, 'error');
      }
    });

    // Re-resolves on every session change this instance didn't itself just
    // trigger synchronously -- covers the initial async session hydration
    // (see the file-level comment at the top of this file), a real
    // password-reset link landing on this page, and a sign-out/sign-in that
    // happened in another tab (Supabase syncs auth state across tabs of the
    // same origin). Also fires redundantly right after handlers above that
    // already call resolveSession() themselves -- harmless, resolveSession()
    // just re-renders from current state either way.
    document.addEventListener('account:updated', resolveSession);

    // account:updated-elsewhere (see account.js's own onAuthStateChange) only
    // ever fires for a USER_UPDATED event this tab didn't itself trigger --
    // in practice, almost always a customer finishing reset-password.html in
    // another tab while this one was already sitting on the Log In step.
    // resolveSession() (bound just above, via the shared 'account:updated'
    // it dispatches first) has already swapped this same tab over to the
    // "Logged in as X" status by the time this listener runs -- this note is
    // just the explicit call-out telling the customer why, since their
    // attention was on the OTHER tab when it happened. Auto-hides itself
    // rather than waiting for the customer to notice and dismiss it.
    let elsewhereNoteTimer = null;
    document.addEventListener('account:updated-elsewhere', () => {
      if (elsewhereNoteTimer) clearTimeout(elsewhereNoteTimer);
      elsewhereNote.textContent = t('accountGate.updatedElsewhere');
      elsewhereNote.hidden = false;
      elsewhereNoteTimer = setTimeout(() => { elsewhereNote.hidden = true; }, 8000);
    });

    resolveSession();

    return { resolveSession };
  }

  global.MonarkAccount = {
    findAccount,
    createAccount,
    verifySignupOtp,
    resendSignupOtp,
    logIn,
    continueAsGuest,
    logOut,
    getSession,
    getCurrentUserId,
    updateAccount,
    recordOrder,
    getOrders,
    deleteAccount,
    requestPasswordReset,
    setNewPassword,
    isPasswordRecovery,
    checkEmailExists,
    mountAccountGate
  };
})(window);
