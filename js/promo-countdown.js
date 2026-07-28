/* MONARK — single shared countdown timer for the site-wide -21% promo.
   Single source of truth for every display that shows this countdown
   (js/promo-banner.js's own banner, product.html's price-note area,
   checkout.html's discount line) -- one target time computed once per page
   load, one setInterval driving every subscriber's callback on the same
   tick, so all displays on a given page always show the exact same
   remaining time. Each display computing its own independent countdown
   (even from the same starting value) risks drifting a second apart from
   the others depending on exactly when each one's own interval happens to
   fire -- subscribing to this one shared tick instead makes that
   impossible by construction.

   Loaded before every page's own js/promo-banner.js (and before product.html/
   checkout.html's own inline scripts that use it) -- see those files' own
   <script> ordering. */
(function (global) {
  /* Fictitious countdown -- purely psychological urgency, not a real
     deadline. Always restarts at 03:52:16 on a fresh load (no localStorage
     persistence); just stops ticking at 00:00:00 rather than doing anything
     else once it hits zero. Anchored to a real Date.now()-based target
     (computed once, below) rather than a plain "seconds remaining" counter
     decremented every tick -- setInterval's own 1000ms period is never
     perfectly exact (it drifts a little under real browser scheduling), so
     recomputing from a fixed target time keeps the displayed value accurate
     to the wall clock instead of accumulating that drift tick after tick. */
  const COUNTDOWN_START_SECONDS = 3 * 3600 + 52 * 60 + 16;
  const targetTime = Date.now() + COUNTDOWN_START_SECONDS * 1000;

  function getRemainingSeconds() {
    return Math.max(0, Math.round((targetTime - Date.now()) / 1000));
  }

  function formatCountdown(totalSeconds) {
    const pad = (n) => String(n).padStart(2, '0');
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  const listeners = [];
  let intervalId = setInterval(() => {
    const secs = getRemainingSeconds();
    listeners.slice().forEach((fn) => fn(secs));
    if (secs <= 0) clearInterval(intervalId);
  }, 1000);

  // Calls `fn` immediately with the current value (so a subscriber's first
  // paint doesn't sit blank for up to a second waiting for the next tick),
  // then again on every subsequent tick. Returns an unsubscribe function --
  // used by anything that can unmount/remove its own display before the
  // countdown reaches zero (the banner's own dismiss() does this today).
  function subscribe(fn) {
    fn(getRemainingSeconds());
    listeners.push(fn);
    return function unsubscribe() {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  global.MonarkPromoCountdown = { subscribe, formatCountdown, getRemainingSeconds };
})(window);
