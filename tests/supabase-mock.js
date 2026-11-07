// Playwright test helper -- stands in for window.MonarkSupabase (the real
// @supabase/supabase-js client js/supabase-client.js builds, see that
// file's own comment) so the signup-OTP spec can exercise js/account.js's
// real createAccount()/verifySignupOtp()/resendSignupOtp()/mountAccountGate()
// code against controllable, offline fake auth responses instead of a real
// Supabase project. Installed via page.addInitScript(), which runs in the
// page BEFORE any of its own <script> tags -- including the real Supabase
// CDN script and js/supabase-client.js -- so window.MonarkSupabase is
// already this mock by the time js/account.js's own module-load-time
// `client().auth.onAuthStateChange(...)` call runs.
//
// The real CDN script (SUPABASE_CDN_URL below) must be blocked by the test
// (page.route(SUPABASE_CDN_URL, (route) => route.abort())) for this mock to
// survive: js/supabase-client.js unconditionally overwrites
// window.MonarkSupabase with a real client if window.supabase.createClient
// exists, and only backs off (its own guard, see that file) when the CDN
// script never loaded at all.
const SUPABASE_CDN_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

// Runs inside the page -- no closures over Node-side variables (Playwright
// serializes this function's source and evaluates it in-page), so every
// configurable bit of behavior is read fresh off window.__mock at call
// time, which the test sets per-scenario via page.evaluate() before
// whichever action is expected to trigger it.
function installSupabaseMock() {
  window.__mock = {
    // signUp() -- set to an {message, status, code} object to simulate a
    // signUp() failure (e.g. a weak-password rejection); null means success.
    signUpError: null,
    // Whether a successful signUp() should come back as "check your email"
    // (needsEmailConfirmation: true, the OTP path this spec is about) or an
    // immediate session (false -- Confirm Email off, not this project's
    // configuration, but the code path createAccount() still supports).
    needsEmailConfirmation: true,
    // verifyOtp()/resend() -- set to an {message, status, code} object to
    // simulate that call failing; null means success. *Throws is a thrown
    // exception instead (simulating a real network failure -- see
    // verifySignupOtp()/resendSignupOtp()'s own try/catch in js/account.js).
    verifyOtpError: null,
    verifyOtpThrows: false,
    resendError: null,
    resendThrows: false,
    // check-email-exists Edge Function stand-in (checkEmailExists()) --
    // false lets the email step fall through to Create Account, matching
    // every scenario this spec needs (a brand-new signup).
    emailExists: false
  };

  const callbacks = [];
  let currentSession = null;
  function notify(event, session) {
    currentSession = session;
    callbacks.slice().forEach((cb) => cb(event, session));
  }

  // Minimal stand-in for supabase-js's own chainable, awaitable query
  // builder -- every chain method returns the same stub (so any call order
  // works), and the stub itself is thenable so `await client().from(...)...`
  // resolves correctly whether or not .single()/.maybeSingle() is the last
  // call in the chain (see js/account.js's own findAccount()/getOrders()/
  // updateAccount() for both shapes).
  function queryStub(data) {
    const stub = {};
    ['select', 'eq', 'order', 'update', 'neq', 'limit'].forEach((method) => {
      stub[method] = () => stub;
    });
    stub.single = () => Promise.resolve({ data: data || null, error: null });
    stub.maybeSingle = () => Promise.resolve({ data: data || null, error: null });
    stub.insert = () => Promise.resolve({ data: null, error: null });
    stub.then = (resolve) => resolve({ data: data ? (Array.isArray(data) ? data : [data]) : [], error: null });
    return stub;
  }

  window.MonarkSupabase = {
    auth: {
      onAuthStateChange(cb) {
        callbacks.push(cb);
        // Mirrors the real client's own async INITIAL_SESSION hydration
        // (see js/account.js's file-level ASYNC NOTE) -- fired on a timer,
        // not synchronously, so this mock exercises the same "briefly no
        // session yet" window the real one does.
        setTimeout(() => cb('INITIAL_SESSION', currentSession), 0);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signUp({ email }) {
        if (window.__mock.signUpError) return { data: { user: null, session: null }, error: window.__mock.signUpError };
        if (window.__mock.needsEmailConfirmation) {
          return { data: { user: { identities: [{ id: 'mock-identity' }] }, session: null }, error: null };
        }
        const session = { user: { id: 'test-uid', email } };
        notify('SIGNED_IN', session);
        return { data: { user: session.user, session }, error: null };
      },
      async verifyOtp({ email }) {
        if (window.__mock.verifyOtpThrows) throw new Error('mock network failure');
        if (window.__mock.verifyOtpError) return { data: null, error: window.__mock.verifyOtpError };
        const session = { user: { id: 'test-uid', email } };
        notify('SIGNED_IN', session);
        return { data: { session, user: session.user }, error: null };
      },
      async resend() {
        if (window.__mock.resendThrows) throw new Error('mock network failure');
        if (window.__mock.resendError) return { data: null, error: window.__mock.resendError };
        return { data: {}, error: null };
      },
      async signInWithPassword() { return { error: { message: 'mock: not used by this spec' } }; },
      async signInWithOAuth() { return { error: null }; },
      async resetPasswordForEmail() { return { error: null }; },
      async updateUser() { return { error: null }; },
      async signOut() { notify('SIGNED_OUT', null); return { error: null }; }
    },
    from(table) {
      return queryStub(table === 'profiles'
        ? { id: 'test-uid', first_name: '', last_name: '', marketing_opt_in: true }
        : null);
    },
    functions: {
      invoke: async (name) => (name === 'check-email-exists'
        ? { data: { exists: !!window.__mock.emailExists }, error: null }
        : { data: null, error: null })
    }
  };
}

module.exports = { SUPABASE_CDN_URL, installSupabaseMock };
