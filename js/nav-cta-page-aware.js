/* MONARK — header "Acquire" CTA, page-aware. Every page carries the exact
   same .nav-cta-acquire markup (Acquire -> product.html, same as
   index.html's own) rather than product.html getting a hand-maintained
   exception written directly into that one page's own markup -- product.html
   is the one page where the button doesn't belong at all (it IS the
   Acquire destination; there's nowhere useful left for it to point). Same
   "detect the current page via location.pathname, don't duplicate per-page
   markup" approach as js/footer-active-page.js's own "you are here"
   indicator, just applied to the header CTA instead of the footer links.
   Include via <script src="js/nav-cta-page-aware.js"></script> AFTER
   js/i18n.js (every page's own script tag order already loads i18n.js
   early) -- not that this specific version depends on load order itself
   (no i18n re-translation involved once the element is just removed), kept
   consistent with where the script previously needed to sit, for an
   earlier version of this file that swapped the button to a
   Home -> index.html link instead of removing it outright -- reverted in
   favor of removing it entirely once asked for that instead. */
(function () {
  const btn = document.querySelector('.nav-cta-acquire');
  if (!btn) return;
  // Every page on this site is always requested by its own explicit
  // filename (see js/footer-active-page.js's own comment) -- no bare-
  // directory/trailing-slash URL in real use here to also account for.
  const currentPage = location.pathname.split('/').pop();
  if (currentPage !== 'product.html') return;

  btn.remove();
})();
