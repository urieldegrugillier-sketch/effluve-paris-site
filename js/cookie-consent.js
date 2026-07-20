/* MONARK — site-wide cookie consent banner (RGPD). Shared across every page;
   include via <script src="js/cookie-consent.js"></script>. */
(function () {
  const STORAGE_KEY = 'monark_cookie_consent';
  if (localStorage.getItem(STORAGE_KEY)) return;

  const banner = document.createElement('div');
  banner.className = 'cookie-banner';
  banner.id = 'cookie-banner';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Cookie consent');
  banner.setAttribute('data-i18n-attr', 'aria-label:cookie.ariaLabel');
  banner.innerHTML = `
    <p class="cookie-banner-text" data-i18n-html="cookie.text">We use cookies to improve your experience and analyze site traffic. Read our <a href="confidentialite.html">privacy policy</a> to learn more.</p>
    <div class="cookie-banner-actions">
      <button type="button" class="cookie-banner-btn cookie-banner-reject" data-i18n="cookie.reject">Reject</button>
      <button type="button" class="cookie-banner-btn cookie-banner-accept" data-i18n="cookie.accept">Accept</button>
    </div>
  `;
  if (window.MonarkI18n) window.MonarkI18n.apply(banner);

  function dismiss(choice) {
    localStorage.setItem(STORAGE_KEY, choice);
    banner.remove();
    // Relaxes any page's own bottom padding (see --cookie-banner-h in
    // css/style.css's :root) straight back to normal once the banner's
    // actually gone, rather than leaving a now-pointless gap at the bottom
    // of the page until the next full reload.
    document.documentElement.style.removeProperty('--cookie-banner-h');
    window.removeEventListener('resize', positionBanner);
  }

  banner.querySelector('.cookie-banner-reject').addEventListener('click', () => dismiss('rejected'));
  banner.querySelector('.cookie-banner-accept').addEventListener('click', () => dismiss('accepted'));

  document.body.appendChild(banner);

  // Same window.innerWidth-driven flicker fixed for .site-header/.section-cta/
  // .canvas-wrap/#dark-overlay in index.html (see js/app.js) -- this banner is
  // position:fixed too and can stay on screen while the user scrolls before
  // dismissing it, so it's exposed to the same bug. clientWidth stays stable
  // across the same scroll where innerWidth measurably flickers.
  //
  // Also (re-)measures the banner's own real rendered HEIGHT on every call,
  // not just its width -- this banner sits fixed to the bottom of the
  // viewport (see its own CSS) and can visually cover whatever page content
  // happens to scroll to right above it, primary CTAs like checkout.html's
  // "Place Order" included, especially on short mobile viewports where a
  // tall page's own bottom padding wasn't accounting for this banner's
  // height at all. --cookie-banner-h (css/style.css's :root) is 0px by
  // default and only pages that actually need the extra clearance opt in by
  // adding it to their own bottom padding (see .checkout-page in
  // css/checkout.css) -- so setting it here has no effect on any page that
  // doesn't. Re-measured on resize (not just once at mount) because the
  // banner's text can wrap differently -- and so its height can change --
  // at a different viewport width.
  function positionBanner() {
    banner.style.width = document.documentElement.clientWidth + 'px';
    document.documentElement.style.setProperty('--cookie-banner-h', banner.getBoundingClientRect().height + 'px');
  }
  positionBanner();
  window.addEventListener('resize', positionBanner);
})();
