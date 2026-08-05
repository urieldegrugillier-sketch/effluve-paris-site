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
   <script> ordering. Also loaded after js/supabase-client.js on every page
   (same ordering requirement) -- this reads admin.html's own Timer tab
   config (public.site_config) from Supabase on load instead of the old
   hardcoded COUNTDOWN_START_SECONDS constant.

   Two modes (site_config.timer_mode):
     'relative'   -- same behavior as before this feature: every visitor's
                     own page load starts a fresh countdown,
                     relative_duration_hours long, no persistence.
     'fixed_date' -- counts down to site_config.fixed_end_date, identical
                     for every visitor, does not reset on refresh. If that
                     date has already passed, every subscriber is told to
                     hide its own display entirely (see subscribe()'s
                     onHide below) rather than showing a static "offer
                     ended" state -- a deliberate product decision, not a
                     gap.

   A lookup failure (site_config unreachable, no row, Supabase not loaded)
   falls back to a default relative countdown rather than hiding the
   promo everywhere -- same "never let a backend hiccup silently remove a
   site-wide feature" spirit as create-checkout-session's own promo-code
   lookup-failure handling. */
(function (global) {
  const FALLBACK_HOURS = 4; // only used if site_config can't be read at all

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
  // ticks out of 60 would read as broken, not "alive".
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

  // targetTime stays null until site_config resolves (async fetch -- see
  // loadConfigAndStart below), and forever null if the resolved config is
  // 'fixed_date' with a date already in the past ("hidden" below stays
  // true in that case, tick() is never scheduled at all). getRemainingSeconds()
  // returning null in both those cases (rather than 0) lets a caller that
  // reads it directly (checkout.html's own initial synchronous render, see
  // that file's own comment) tell "not yet known / never showing" apart
  // from a real, ticking-down zero.
  let targetTime = null;
  let resolved = false;
  let hidden = false;
  let intervalId = null;
  const listeners = [];
  const pendingSubscribers = []; // { onTick, onHide } queued until config resolves

  function getRemainingSeconds() {
    if (targetTime === null) return null;
    return Math.max(0, Math.round((targetTime - Date.now()) / 1000));
  }

  function tick() {
    const secs = getRemainingSeconds();
    const units = unitsFromSeconds(secs);
    const changed = computeChanged(units);
    lastUnits = units;
    listeners.slice().forEach((fn) => fn(secs, changed));
    if (secs <= 0) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function startTicking() {
    lastUnits = unitsFromSeconds(getRemainingSeconds());
    intervalId = setInterval(tick, 1000);
  }

  // Calls onTick immediately with the current value (so a subscriber's
  // first paint doesn't sit blank for up to a second waiting for the next
  // tick), then again on every subsequent tick -- same guarantee the old,
  // synchronous version of this module made. The only difference now:
  // resolution is async (site_config hasn't necessarily loaded yet when a
  // page's own script calls subscribe()), so a subscriber registered before
  // that happens is queued in pendingSubscribers and gets its first call
  // (onTick or onHide, whichever applies) once resolveConfig() below runs.
  // Returns an unsubscribe function either way.
  function subscribe(onTick, onHide) {
    if (!resolved) {
      pendingSubscribers.push({ onTick, onHide });
      return function unsubscribe() {
        const i = pendingSubscribers.findIndex((s) => s.onTick === onTick);
        if (i !== -1) pendingSubscribers.splice(i, 1);
        const j = listeners.indexOf(onTick);
        if (j !== -1) listeners.splice(j, 1);
      };
    }
    if (hidden) {
      if (onHide) onHide();
      return function unsubscribe() {};
    }
    const secs = getRemainingSeconds();
    onTick(secs, { hours: false, minutes: false });
    listeners.push(onTick);
    return function unsubscribe() {
      const i = listeners.indexOf(onTick);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  function resolveConfig(config) {
    resolved = true;
    if (config.hidden) {
      hidden = true;
      pendingSubscribers.forEach(({ onHide }) => { if (onHide) onHide(); });
      pendingSubscribers.length = 0;
      return;
    }
    targetTime = config.targetTime;
    startTicking();
    pendingSubscribers.forEach(({ onTick }) => {
      const secs = getRemainingSeconds();
      onTick(secs, { hours: false, minutes: false });
      listeners.push(onTick);
    });
    pendingSubscribers.length = 0;
  }

  async function loadConfigAndStart() {
    try {
      if (!global.MonarkSupabase) throw new Error('Supabase client not ready');
      const { data, error } = await global.MonarkSupabase
        .from('site_config')
        .select('timer_mode, relative_duration_hours, fixed_end_date')
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('No site_config row');

      if (data.timer_mode === 'fixed_date') {
        const endMs = data.fixed_end_date ? new Date(data.fixed_end_date).getTime() : NaN;
        if (!Number.isFinite(endMs) || endMs <= Date.now()) {
          resolveConfig({ hidden: true });
          return;
        }
        resolveConfig({ hidden: false, targetTime: endMs });
        return;
      }

      const hours = Number(data.relative_duration_hours);
      const effectiveHours = Number.isFinite(hours) && hours > 0 ? hours : FALLBACK_HOURS;
      resolveConfig({ hidden: false, targetTime: Date.now() + effectiveHours * 3600 * 1000 });
    } catch (err) {
      console.error('promo-countdown.js: site_config lookup failed, falling back to default relative countdown:', err && err.message);
      resolveConfig({ hidden: false, targetTime: Date.now() + FALLBACK_HOURS * 3600 * 1000 });
    }
  }

  loadConfigAndStart();

  global.MonarkPromoCountdown = { subscribe, formatCountdown, formatCountdownHTML, getRemainingSeconds };
})(window);
