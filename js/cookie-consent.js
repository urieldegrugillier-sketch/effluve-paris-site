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
  }

  banner.querySelector('.cookie-banner-reject').addEventListener('click', () => dismiss('rejected'));
  banner.querySelector('.cookie-banner-accept').addEventListener('click', () => dismiss('accepted'));

  document.body.appendChild(banner);

  // Same window.innerWidth-driven flicker fixed for .site-header/.section-cta/
  // .canvas-wrap/#dark-overlay in index.html (see js/app.js) -- this banner is
  // position:fixed too and can stay on screen while the user scrolls before
  // dismissing it, so it's exposed to the same bug. clientWidth stays stable
  // across the same scroll where innerWidth measurably flickers.
  function positionBannerWidth() {
    banner.style.width = document.documentElement.clientWidth + 'px';
  }
  positionBannerWidth();
  window.addEventListener('resize', positionBannerWidth);
})();
