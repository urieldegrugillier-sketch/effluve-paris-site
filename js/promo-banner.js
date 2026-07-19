/* MONARK — site-wide dismissible announcement banner, relaying the same
   -17% offer already highlighted in index.html §006's .cta-discount-badge
   (near-identical phrasing, just with "Offer" inserted for this banner's
   own standalone context -- see that badge's own markup). Shared across
   every page; include via
   <script src="js/promo-banner.js"></script> alongside the other shared,
   bottom-of-body scripts (js/cookie-consent.js, js/email-popup.js) -- same
   loading convention as those, nothing special about this one's placement.

   Dismissal (via the × button) is remembered in localStorage so it only
   ever shows once per visitor, same pattern as js/cookie-consent.js's own
   dismissal flag -- just a separate key, since accepting/rejecting cookies
   has nothing to do with having already seen this offer. */
(function () {
  const STORAGE_KEY = 'monark_promo_banner_dismissed';
  if (localStorage.getItem(STORAGE_KEY)) return;

  const banner = document.createElement('div');
  banner.className = 'promo-banner';
  banner.id = 'promo-banner';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Promotional offer');
  banner.setAttribute('data-i18n-attr', 'aria-label:promoBanner.ariaLabel');
  // Two lines always (not just wrapped at narrow widths) -- one consistent,
  // measured height at every breakpoint (css/style.css's --promo-banner-h)
  // instead of the single-line version wrapping unpredictably once this
  // countdown text was added, which would silently mismatch that constant
  // and either gap or overlap .site-header depending on viewport width.
  // "Offer" and "Ends in " are tagged individually (not the whole <p> via one
  // data-i18n) so MonarkI18n.apply() only ever overwrites textContent on
  // those two spans -- the countdown span in between ticks every second via
  // its own textContent write (see the setInterval below) and would be wiped
  // by a language switch if it were caught in the same swap.
  banner.innerHTML = `
    <p class="promo-banner-text"><a href="product.html"><span data-i18n="promoBanner.offer">Limited-Time Offer &minus;17% Off</span><br><span class="promo-banner-timer-line"><span data-i18n="promoBanner.endsIn">Ends in </span><span class="promo-banner-timer" id="promo-banner-timer">17:42:39</span></span></a></p>
    <button type="button" class="promo-banner-close" aria-label="Dismiss" data-i18n-attr="aria-label:promoBanner.dismiss">&times;</button>
  `;
  if (window.MonarkI18n) window.MonarkI18n.apply(banner);

  /* Fictitious countdown -- purely psychological urgency, not a real
     deadline. Always restarts at 17:42:39 on a fresh load (no localStorage
     persistence, unlike DISMISS_KEY above); just stops at 00:00:00 rather
     than doing anything to the banner itself once it hits zero. */
  const COUNTDOWN_START_SECONDS = 17 * 3600 + 42 * 60 + 39;
  let remainingSeconds = COUNTDOWN_START_SECONDS;
  const timerEl = banner.querySelector('#promo-banner-timer');

  function formatCountdown(totalSeconds) {
    const pad = (n) => String(n).padStart(2, '0');
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  let countdownInterval = setInterval(() => {
    remainingSeconds -= 1;
    if (remainingSeconds <= 0) {
      remainingSeconds = 0;
      clearInterval(countdownInterval);
    }
    timerEl.textContent = formatCountdown(remainingSeconds);
  }, 1000);

  // Inserted before every other body child (including .site-header), not
  // just visually on top of it via z-index -- source order matches visual
  // order. .promo-banner-active on <html> is what pushes .site-header (and
  // every page's own header-clearance rule) down by the banner's height --
  // see --promo-banner-h in css/style.css's :root.
  document.body.insertBefore(banner, document.body.firstChild);
  document.documentElement.classList.add('promo-banner-active');

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, 'true');
    // Removing the banner from the DOM doesn't stop its interval on its own
    // -- setInterval keeps firing (and retaining timerEl/banner in its
    // closure) until explicitly cleared, which would otherwise leak a
    // dangling tick-every-second timer for the rest of the page's life.
    clearInterval(countdownInterval);
    document.documentElement.classList.remove('promo-banner-active');
    // Matches .site-header's own `transition: top 0.4s ease` (css/style.css)
    // -- the banner slides/fades out over the same duration the header takes
    // to ease back up to top:0, instead of vanishing instantly while the
    // header's still mid-transition.
    banner.style.opacity = '0';
    banner.style.transform = 'translateY(-100%)';
    setTimeout(() => banner.remove(), 400);
  }

  banner.querySelector('.promo-banner-close').addEventListener('click', dismiss);

  // Same window.innerWidth-driven flicker fix as .site-header/.cookie-banner/
  // .canvas-wrap/#dark-overlay elsewhere (see their own comments) -- this
  // banner is position:fixed too and can stay on screen while the user
  // scrolls before dismissing it, so it's exposed to the same bug.
  function positionBannerWidth() {
    banner.style.width = document.documentElement.clientWidth + 'px';
  }
  positionBannerWidth();
  window.addEventListener('resize', positionBannerWidth);
})();
