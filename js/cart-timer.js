/* MONARK — shared "time left to complete your order" cart countdown.
   Pure state module (no DOM of its own) -- js/cart-widget.js (drawer/preview)
   and js/checkout-page.js (checkout summary) each subscribe and render their
   own markup from the state this reports, same split as js/promo-countdown.js
   vs. its own consumers.

   One end time, stored in localStorage (STORAGE_KEY below) so it survives
   reloads/page changes and reads the same on every tab (a 'storage' event
   fires in every OTHER tab whenever one tab writes/clears it -- see the
   listener near the bottom). Starts the first time the cart goes from empty
   to non-empty, left untouched by later quantity changes, cleared the moment
   the cart becomes empty again (which also covers a paid order: both
   checkout-page.js's completeOrder() and product-page.js's Payment Request
   Button handler call cart.clearCart() on success, which is what actually
   empties the cart -- no separate "paid" hook needed here). */
(function (global) {
  const CART_TIMER_MINUTES = 15; // single constant -- change this to retune the countdown length
  const CART_TIMER_SECONDS = CART_TIMER_MINUTES * 60;
  const STORAGE_KEY = 'monark_cart_timer_end';

  // In-memory fallback for the rare case localStorage throws (private
  // browsing lockdown, quota, etc.) -- same "never let a storage failure
  // break the feature" spirit as js/cart.js's own readCart()/writeCart().
  // Doesn't survive a reload in that case, but the timer still works for the
  // rest of this tab's session instead of silently never appearing.
  let memoryEndTime = null;

  function readEndTime() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch (e) {
      return memoryEndTime;
    }
  }

  function writeEndTime(ms) {
    memoryEndTime = ms;
    try { localStorage.setItem(STORAGE_KEY, String(ms)); } catch (e) {}
  }

  function clearEndTime() {
    memoryEndTime = null;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  function getCartCount() {
    return global.MonarkCart ? global.MonarkCart.getCartCount() : 0;
  }

  // Only ever writes a fresh end time when none is stored -- never shortens
  // or extends one already running, so a quantity bump/Add Another doesn't
  // reset the clock back to 15:00.
  function ensureStarted() {
    if (readEndTime() === null) writeEndTime(Date.now() + CART_TIMER_SECONDS * 1000);
  }

  // The explicit "restart" offered once the countdown has expired (see each
  // consumer's own expired-state markup/button) -- always starts a fresh
  // CART_TIMER_SECONDS, regardless of what was stored before.
  function restart() {
    writeEndTime(Date.now() + CART_TIMER_SECONDS * 1000);
    notify();
  }

  function computeState() {
    if (getCartCount() === 0) return { visible: false, expired: false, seconds: 0 };
    ensureStarted();
    const end = readEndTime();
    const seconds = Math.max(0, Math.round((end - Date.now()) / 1000));
    return { visible: true, expired: seconds <= 0, seconds };
  }

  const listeners = [];
  function subscribe(fn) {
    listeners.push(fn);
    fn(computeState());
    return function unsubscribe() {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  function notify() {
    const state = computeState();
    listeners.slice().forEach((fn) => fn(state));
  }

  function formatMMSS(totalSeconds) {
    const pad = (n) => String(n).padStart(2, '0');
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${pad(m)}:${pad(s)}`;
  }

  setInterval(notify, 1000);

  // Cart going to/from empty is the only mutation this module itself reacts
  // to (start-on-first-item, clear-on-empty) -- every other cart:updated
  // (quantity change, promo code) is irrelevant to the countdown itself, but
  // notify() is still cheap to call on all of them so any visible display
  // stays in sync without waiting up to a second for the next tick.
  document.addEventListener('cart:updated', () => {
    if (getCartCount() === 0) clearEndTime();
    notify();
  });

  // Fires in every OTHER tab (never the one that made the change) whenever
  // this storage key is written/cleared -- re-reading here is what makes
  // every open tab converge on the exact same end time rather than each
  // running its own independent clock.
  global.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) notify();
  });

  global.MonarkCartTimer = { subscribe, restart, formatMMSS, getState: computeState };
})(window);
