/* MONARK — shared header width/logo-centering fix.
   Included on every page EXCEPT index.html, which already carries the
   equivalent logic inline in js/app.js (that file also drives the scroll
   choreography, canvas, dark overlay, etc. that only index.html has).

   Root cause this fixes: .nav-logo relies entirely on JS to set its `left`
   (see css/style.css's .nav-logo comment) rather than a CSS left:50%, because
   left:50% on a position:fixed descendant resolves against a viewport-width
   metric that measurably flickers during real touch/momentum scroll on mobile
   (confirmed several rounds ago on index.html). That JS lived only in app.js,
   which only index.html loads -- every other page's .nav-logo has therefore
   had NO left position at all, defaulting to wherever the browser's
   position:absolute "static position" fallback happens to land. Confirmed via
   screenshot: on desktop widths, where the header's other nav link ("The
   Experience") isn't hidden, this rendered as the logo directly overlapping
   that link -- garbled, illegible text, on every one of these pages, at every
   desktop width. .site-header's own width (also JS-driven on index.html, for
   the same underlying reason) has the same gap here. */
(function () {
  const navLogo = document.querySelector('.nav-logo');
  const siteHeader = document.querySelector('.site-header');

  function positionNavLogo() {
    if (!navLogo) return;
    navLogo.style.left = (document.documentElement.clientWidth / 2) + 'px';
  }

  function positionHeaderWidth() {
    if (!siteHeader) return;
    siteHeader.style.width = document.documentElement.clientWidth + 'px';
  }

  positionNavLogo();
  positionHeaderWidth();
  window.addEventListener('resize', positionNavLogo);
  window.addEventListener('resize', positionHeaderWidth);
})();
