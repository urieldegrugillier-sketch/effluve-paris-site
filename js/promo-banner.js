/* MONARK — site-wide dismissible announcement banner, relaying the same
   -21% offer already highlighted in index.html §006's .cta-discount-badge
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
  // Single line now (the old "Limited-Time Offer -21% Off" headline above
  // this was removed -- the countdown itself already carries the "offer"
  // framing via promoBanner.endsIn, a second line just repeating it added
  // nothing). "Ends in " is tagged individually (not the whole <p> via one
  // data-i18n) so MonarkI18n.apply() only ever overwrites textContent on
  // that one span -- the countdown span right after it ticks every second
  // via its own textContent write (see the setInterval below) and would be
  // wiped by a language switch if it were caught in the same swap.
  banner.innerHTML = `
    <p class="promo-banner-text"><a href="product.html"><span class="promo-banner-timer-line"><span class="promo-banner-timer-label" data-i18n="promoBanner.endsIn">Ends in</span><span class="promo-banner-timer" id="promo-banner-timer">03:52:16</span></span></a></p>
    <button type="button" class="promo-banner-close" aria-label="Dismiss" data-i18n-attr="aria-label:promoBanner.dismiss">&times;</button>
  `;
  if (window.MonarkI18n) window.MonarkI18n.apply(banner);

  /* Countdown display only -- the actual target time/ticking lives in
     js/promo-countdown.js (loaded before this script, see this page's own
     <script> ordering), shared with product.html's and checkout.html's own
     countdown displays so all three always show the exact same remaining
     time rather than each running an independent timer that could drift a
     second apart from the others. */
  const timerEl = banner.querySelector('#promo-banner-timer');

  // formatCountdownHTML() (js/promo-countdown.js) wraps each unit in its own
  // span -- seconds gets the continuous pulse (.promo-timer-seconds), hours/
  // minutes get a one-shot fade/scale-in (.promo-timer-flip) only on the
  // tick their own value actually changes (the `changed` flags below, computed
  // once per tick in that shared module so every display agrees on exactly
  // when "the minute changed" happened).
  const unsubscribe = window.MonarkPromoCountdown.subscribe((secs, changed) => {
    timerEl.innerHTML = window.MonarkPromoCountdown.formatCountdownHTML(secs, changed);
  });

  // Inserted before every other body child (including .site-header), not
  // just visually on top of it via z-index -- source order matches visual
  // order. .promo-banner-active on <html> is what pushes .site-header (and
  // every page's own header-clearance rule) down by the banner's height --
  // see --promo-banner-h in css/style.css's :root.
  document.body.insertBefore(banner, document.body.firstChild);
  document.documentElement.classList.add('promo-banner-active');

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, 'true');
    // Removing the banner from the DOM doesn't stop it listening to the
    // shared countdown on its own -- unsubscribe() drops this callback from
    // js/promo-countdown.js's own listener list, which would otherwise keep
    // retaining timerEl/banner in its closure and writing into a detached
    // element for the rest of the page's life (the shared timer itself
    // keeps running either way -- other subscribers, if any, are unaffected).
    unsubscribe();
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
