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

  function unitsFromSeconds(totalSeconds) {
    return {
      h: Math.floor(totalSeconds / 3600),
      m: Math.floor((totalSeconds % 3600) / 60)
    };
  }

  // Hours/minutes change far less often than seconds (once an hour / once a
  // minute vs. every tick), so they get a one-shot "digit just changed"
  // effect (see .promo-timer-flip, css/style.css) instead of seconds' own
  // continuous pulse -- constantly animating something that's static 59
  // ticks out of 60 would read as broken, not "alive". lastUnits is tracked
  // HERE (not per-subscriber) since every subscriber on a given page ticks
  // off the exact same shared secs value each interval -- "did the hour/
  // minute change this tick" has one right answer per tick, not one per
  // display. Seeded by whichever subscriber calls subscribe() first (below)
  // rather than left null until the first interval fire, so a page that
  // happens to load right at a minute boundary can't misread that as
  // "changed" before there was ever a previous value to compare against.
  let lastUnits = null;
  function computeChanged(units) {
    if (!lastUnits) return { hours: false, minutes: false };
    return { hours: units.h !== lastUnits.h, minutes: units.m !== lastUnits.m };
  }

  // Single shared HTML builder for every display (banner, product.html,
  // checkout.html) -- one place that knows the "hours/minutes/seconds each
  // get their own span, minutes/hours additionally get .promo-timer-flip
  // when they just changed" markup shape, rather than three independently
  // maintained copies of it. Safe as innerHTML: every piece comes straight
  // out of formatCountdown()'s own zero-padded digit-and-colon output,
  // never from user input.
  function formatCountdownHTML(totalSeconds, changed) {
    const [hours, minutes, seconds] = formatCountdown(totalSeconds).split(':');
    const flip = (base, didChange) => base + (didChange ? ' promo-timer-flip' : '');
    return `<span class="${flip('promo-timer-hours', changed && changed.hours)}">${hours}</span>:` +
      `<span class="${flip('promo-timer-minutes', changed && changed.minutes)}">${minutes}</span>:` +
      `<span class="promo-timer-seconds">${seconds}</span>`;
  }

  const listeners = [];
  let intervalId = setInterval(() => {
    const secs = getRemainingSeconds();
    const units = unitsFromSeconds(secs);
    const changed = computeChanged(units);
    lastUnits = units;
    listeners.slice().forEach((fn) => fn(secs, changed));
    if (secs <= 0) clearInterval(intervalId);
  }, 1000);

  // Calls `fn` immediately with the current value (so a subscriber's first
  // paint doesn't sit blank for up to a second waiting for the next tick),
  // then again on every subsequent tick. Returns an unsubscribe function --
  // used by anything that can unmount/remove its own display before the
  // countdown reaches zero (the banner's own dismiss() does this today).
  // Always reports {hours:false, minutes:false} on this first, immediate
  // call -- a display's very first paint should never play the "just
  // changed" effect, only a real change on a later tick should.
  function subscribe(fn) {
    const secs = getRemainingSeconds();
    if (!lastUnits) lastUnits = unitsFromSeconds(secs);
    fn(secs, { hours: false, minutes: false });
    listeners.push(fn);
    return function unsubscribe() {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  global.MonarkPromoCountdown = { subscribe, formatCountdown, formatCountdownHTML, getRemainingSeconds };
})(window);
