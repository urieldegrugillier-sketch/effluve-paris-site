(function () {
  // Same shared countdown js/promo-banner.js's own banner subscribes to
  // (see js/promo-countdown.js) -- this page's own display always shows the
  // exact same remaining time, never a second independent timer.
  function t(key, vars) { return window.MonarkI18n ? window.MonarkI18n.t(key, vars) : key; }
  const containerEl = document.getElementById('product-countdown');
  const labelEl = document.getElementById('product-countdown-label');
  const timerEl = document.getElementById('product-countdown-timer');
  if (!containerEl || !labelEl || !timerEl || !window.MonarkPromoCountdown) return;

  function renderLabel() {
    labelEl.textContent = t('promoBanner.endsIn');
  }
  renderLabel();
  document.addEventListener('monark:langchange', renderLabel);

  // formatCountdownHTML() (js/promo-countdown.js) wraps each unit in its own
  // span -- seconds gets the continuous pulse, hours/minutes get a one-shot
  // fade/scale-in only on the tick their own value actually changed (see
  // that file's own comment on the shared `changed` computation). onHide
  // (admin.html's Timer tab set a fixed_end_date that's already passed)
  // hides this whole price-note row -- no CSS override needed, this <p>
  // has no conflicting `display` rule (see css/shop.css).
  window.MonarkPromoCountdown.subscribe(
    (secs, changed) => {
      timerEl.innerHTML = window.MonarkPromoCountdown.formatCountdownHTML(secs, changed);
    },
    () => { containerEl.hidden = true; }
  );
})();
