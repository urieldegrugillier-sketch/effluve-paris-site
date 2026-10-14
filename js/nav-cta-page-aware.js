/* MONARK — header "Acquire" CTA, page-aware. Every page carries the exact
   same .nav-cta-acquire markup (Acquire -> product.html, same as
   index.html's own) rather than product.html getting its own differently-
   worded copy hand-maintained in parallel -- product.html is the one page
   where that link would point at itself, so it's swapped here to
   Home -> index.html instead. Same "detect the current page via
   location.pathname, don't duplicate per-page markup" approach as
   js/footer-active-page.js's own "you are here" indicator, just applied to
   the header CTA instead of the footer links.
   Include via <script src="js/nav-cta-page-aware.js"></script> AFTER
   js/i18n.js (every page's own script tag order already loads i18n.js
   early) -- i18n.js's own apply() already ran once by the time this
   executes, translating the button's original data-i18n="nav.acquire" into
   its displayed text; updating the attribute to nav.home here keeps any
   LATER language switch (js/i18n.js's setLang() re-applies every
   [data-i18n] element) correctly re-translating this button too, not just
   the one-time text set directly below. */
(function () {
  const btn = document.querySelector('.nav-cta-acquire');
  if (!btn) return;
  // Every page on this site is always requested by its own explicit
  // filename (see js/footer-active-page.js's own comment) -- no bare-
  // directory/trailing-slash URL in real use here to also account for.
  const currentPage = location.pathname.split('/').pop();
  if (currentPage !== 'product.html') return;

  btn.setAttribute('href', 'index.html');
  btn.setAttribute('data-i18n', 'nav.home');
  if (window.MonarkI18n) btn.textContent = window.MonarkI18n.t('nav.home');
})();
