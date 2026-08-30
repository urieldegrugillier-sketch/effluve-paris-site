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
  function client() { return global.MonarkSupabase; }

  const GUEST_KEY = 'monark_guest_email';
  const MOCK_CARD_KEY_PREFIX = 'monark_mock_card_';
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
      if (error.status === 429 || error.code === 'over_email_send_rate_limit') return { ok: false, error: 'rate-limited' };
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
    if (error) return { ok: false, error: 'invalid' };
    return { ok: true };
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
      deliveredAt: row.delivered_at
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
        <p class="promo-message promo-message-success" id="checkout-account-confirm-pending" aria-live="polite" hidden></p>
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
    const confirmPending = container.querySelector('#checkout-account-confirm-pending');

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
      authBlock.hidden = step !== 'auth';
      recoveryBlock.hidden = step !== 'recovery';
      if (step !== 'auth') {
        createForm.hidden = true;
        confirmPending.hidden = true;
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
        statusEl.hidden = true;
        showStep('email');
        emailInput.value = '';
        emailError.hidden = true;
        createdNote.hidden = true;
        emailAlreadyExists = false;
        previousSession = null;
        emailCancelBtn.hidden = true;
        authCancelBtn.hidden = true;
        if (options.onUnresolved) options.onUnresolved();
        return;
      }
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
      confirmPending.hidden = true;
    }

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
        const result = await logIn(authEmailEcho.textContent, loginPasswordInput.value);
        if (result.ok) {
          resolveSession();
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
          showFieldError(guestPasswordError, 'accountGate.errorWrongPassword');
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
            : result.error === 'rate-limited' ? 'accountGate.errorRateLimited'
            : 'accountGate.errorGeneric';
          showFieldError(createError, errorKey);
          return;
        }
        if (result.needsEmailConfirmation) {
          // No session yet -- shown inline here (not via createdNote +
          // resolveSession(), which only make sense once a session actually
          // exists) so the message doesn't get wiped the instant
          // resolveSession() re-checks and finds nothing yet.
          createForm.hidden = true;
          confirmPending.textContent = t('accountGate.confirmAccountPending', { email: newAccountEmail });
          confirmPending.hidden = false;
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
