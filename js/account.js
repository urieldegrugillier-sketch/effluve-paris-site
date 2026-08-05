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

  // PLACEHOLDER -- replace once the real production domain is live, same
  // convention as README.md's "https://effluve-paris.fr" note (canonical
  // links, robots.txt, sitemap.xml). Supabase redirects the user here after
  // they click the password-reset link in their email.
  const PASSWORD_RESET_REDIRECT_URL = 'https://effluve-paris.fr/account.html';

  let currentAuthUser = null; // { id, email } | null -- kept in sync below
  let currentProfile = null; // last-fetched public.profiles row for currentAuthUser, cleared on any auth change
  let passwordRecoveryActive = false; // true between a PASSWORD_RECOVERY auth event and a successful setNewPassword()

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
      if (event === 'PASSWORD_RECOVERY') passwordRecoveryActive = true;
      currentAuthUser = session && session.user ? { id: session.user.id, email: session.user.email } : null;
      currentProfile = null;
      // A real session always wins over a leftover guest email -- e.g. a user
      // who started a guest checkout, then logged in on another tab.
      if (currentAuthUser) localStorage.removeItem(GUEST_KEY);
      notifySessionChange();
    });
  } else {
    console.error('MonarkAccount: Supabase client unavailable -- account features will fail until js/supabase-client.js has real SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY values.');
  }

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

  function isPasswordRecovery() { return passwordRecoveryActive; }

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
        // Expected to be read by the public.profiles insert trigger already
        // set up in the Supabase SQL editor (handle_new_user(), see its own
        // updated definition in the migration this feature shipped with) --
        // if that trigger doesn't pull these from raw_user_meta_data, they
        // land empty/default until the user fills in Edit Profile
        // themselves. marketing_opt_in is coalesced to true server-side if
        // this key is ever missing (e.g. an older cached script), matching
        // profileToAccountShape()'s own "not false = true" default below.
        data: {
          first_name: extra.firstName || '',
          last_name: extra.lastName || '',
          marketing_opt_in: extra.marketingOptIn !== false,
          phone: extra.phone || '',
          dial_code: extra.dialCode || '',
          country: extra.country || ''
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
  // only by mountAccountGate() below to decide whether to show the login-only
  // view or the normal guest/create-account choices. Fails open (returns
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
      const { error } = await client().auth.updateUser(authPatch);
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
      paymentIntentId: row.payment_intent_id
    }));
  }

  // SECURITY: full account deletion (removing the auth.users row, and by
  // cascade its profiles/orders rows) requires Supabase's admin/
  // service-role API -- the publishable key this file uses can't do it, and
  // a service-role key must never ship client-side (it bypasses RLS
  // entirely for every table). What's safely possible from here is signing
  // out and clearing local state. Real deletion needs a server-side
  // Supabase Edge Function (using the service-role key there, invoked from
  // here via client().functions.invoke('delete-account') once that function
  // exists) as a follow-up task -- not attempting an insecure workaround.
  async function deleteAccount(email) {
    await logOut();
    return { ok: true, requiresServerSideFollowUp: true };
  }

  async function requestPasswordReset(email) {
    const { error } = await client().auth.resetPasswordForEmail(String(email || '').trim(), {
      redirectTo: PASSWORD_RESET_REDIRECT_URL
    });
    if (error) {
      console.error('MonarkAccount.requestPasswordReset:', error.message);
      return { ok: false };
    }
    return { ok: true };
  }

  // Only meaningful while isPasswordRecovery() is true (the user arrived via
  // a password-reset email link, which gives them a temporary recovery
  // session authorized to call this) -- see mountAccountGate()'s recovery
  // step below.
  async function setNewPassword(password) {
    const { error } = await client().auth.updateUser({ password: String(password || '') });
    if (error) {
      console.error('MonarkAccount.setNewPassword:', error.message);
      return { ok: false };
    }
    passwordRecoveryActive = false;
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
            <ul class="password-requirements" id="checkout-account-create-password-requirements" data-i18n-attr="aria-label:accountGate.passwordHint" aria-label="Minimum 8 characters, with at least one letter, one number, and one special character (! @ # $ % &amp; *).">
              <li class="password-requirement" data-requirement="length"><span class="password-requirement-icon" aria-hidden="true">○</span><span data-i18n="accountGate.passwordReqLength">8+ characters</span></li>
              <li class="password-requirement" data-requirement="letter"><span class="password-requirement-icon" aria-hidden="true">○</span><span data-i18n="accountGate.passwordReqLetter">One letter</span></li>
              <li class="password-requirement" data-requirement="number"><span class="password-requirement-icon" aria-hidden="true">○</span><span data-i18n="accountGate.passwordReqNumber">One number</span></li>
              <li class="password-requirement" data-requirement="special"><span class="password-requirement-icon" aria-hidden="true">○</span><span data-i18n="accountGate.passwordReqSpecial">One special character (! @ # $ % &amp; *)</span></li>
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

      <!-- Reached only via a real password-reset email link (Supabase grants
           a temporary recovery session that authorizes setNewPassword()) --
           see mountAccountGate()'s PASSWORD_RECOVERY handling below. -->
      <div id="checkout-account-recovery" hidden>
        <p class="checkout-account-intro" data-i18n="accountGate.setNewPasswordHeading">Set a New Password</p>
        <form id="checkout-account-recovery-form" novalidate>
          <label class="checkout-field">
            <span data-i18n="accountGate.newPasswordLabel">New Password</span>
            <input type="password" id="checkout-account-recovery-password" autocomplete="new-password" required>
          </label>
          <p class="promo-message promo-message-error" id="checkout-account-recovery-error" aria-live="polite" hidden></p>
          <button type="submit" class="cta-button checkout-account-btn-sm" id="checkout-account-recovery-submit-btn" data-i18n="accountGate.setNewPasswordBtn">Set Password</button>
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
    const recoveryForm = container.querySelector('#checkout-account-recovery-form');
    const recoveryPasswordInput = container.querySelector('#checkout-account-recovery-password');
    const recoverySubmitBtn = container.querySelector('#checkout-account-recovery-submit-btn');
    const recoveryError = container.querySelector('#checkout-account-recovery-error');

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
    // set is the common/standard one (not exotic Unicode symbols) -- kept in
    // one place here so the live checklist below, this check, and
    // account.html's own identical copy (its Edit Profile password-change
    // field, which reuses the same rule/message but has no checklist of its
    // own, out of this feature's scope) can't drift out of sync with each
    // other or with the accountGate.passwordHint/passwordReqSpecial wording.
    const PASSWORD_SPECIAL_CHARS_RE = /[!@#$%&*]/;
    function isValidPassword(value) {
      return value.length >= 8 && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && PASSWORD_SPECIAL_CHARS_RE.test(value);
    }

    // Live requirements checklist (create-account form only -- see this
    // file's own comment above on scope) -- each item's met/unmet state is
    // just isValidPassword()'s own four conditions checked individually
    // instead of combined, so the user sees exactly which ones are still
    // missing instead of one all-or-nothing pass/fail. ○/✓ glyphs (not
    // color alone) so the state doesn't rely on color perception either.
    const createPasswordRequirements = container.querySelector('#checkout-account-create-password-requirements');
    const PASSWORD_REQUIREMENT_CHECKS = {
      length: (value) => value.length >= 8,
      letter: (value) => /[A-Za-z]/.test(value),
      number: (value) => /[0-9]/.test(value),
      special: (value) => PASSWORD_SPECIAL_CHARS_RE.test(value)
    };
    function updatePasswordRequirements() {
      if (!createPasswordRequirements) return;
      const value = createPasswordInput.value;
      Object.keys(PASSWORD_REQUIREMENT_CHECKS).forEach((key) => {
        const item = createPasswordRequirements.querySelector(`[data-requirement="${key}"]`);
        if (!item) return;
        const met = PASSWORD_REQUIREMENT_CHECKS[key](value);
        item.classList.toggle('password-requirement-met', met);
        const icon = item.querySelector('.password-requirement-icon');
        if (icon) icon.textContent = met ? '✓' : '○';
      });
    }
    createPasswordInput.addEventListener('input', updatePasswordRequirements);

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
        statusEl.hidden = true;
        showStep('recovery');
        recoveryPasswordInput.value = '';
        recoveryError.hidden = true;
        return;
      }
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
      if (resolvedKey === lastResolvedKey) return;
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
      updatePasswordRequirements();
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
      forgotPasswordStatus.textContent = result.ok
        ? t('accountGate.resetPasswordSent', { email })
        : t('accountGate.resetPasswordError');
      forgotPasswordStatus.className = 'promo-message ' + (result.ok ? 'promo-message-success' : 'promo-message-error');
      forgotPasswordStatus.hidden = false;
    });

    guestBtn.addEventListener('click', async () => {
      await continueAsGuest(authEmailEcho.textContent);
      resolveSession();
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
      if (!isValidPassword(recoveryPasswordInput.value)) {
        showFieldError(recoveryError, 'accountGate.errorPasswordWeak');
        return;
      }
      recoveryError.hidden = true;
      // Single dominant field -- same disable-input-and-button pattern as
      // the email step's own emailSubmitBtn/emailInput.
      recoverySubmitBtn.disabled = true;
      recoveryPasswordInput.disabled = true;
      try {
        const result = await setNewPassword(recoveryPasswordInput.value);
        if (result.ok) {
          resolveSession();
        } else {
          showFieldError(recoveryError, 'accountGate.errorGeneric');
        }
      } finally {
        recoverySubmitBtn.disabled = false;
        recoveryPasswordInput.disabled = false;
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
      statusEl.hidden = true;
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
    mountAccountGate
  };
})(window);
