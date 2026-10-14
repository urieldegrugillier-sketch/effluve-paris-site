/* MONARK — header "Acquire" CTA, page-aware. Every page carries the exact
   same .nav-cta-acquire markup (Acquire -> product.html, same as
   index.html's own) rather than product.html getting a hand-maintained
   exception written directly into that one page's own markup -- product.html
   is the one page where the button doesn't belong at all (it IS the
   Acquire destination; there's nowhere useful left for it to point).

   BUG FIX (button still visible on the product page in production): this
   used to detect "am I on product.html" purely from
   location.pathname.split('/').pop() === 'product.html' -- correct against
   a plain static file server (local dev), but Cloudflare serves this site
   with clean URLs (any .html-suffixed request redirects to its extension-
   less equivalent), so location.pathname in production is "/product",
   never literally "product.html" the way this codebase's own internal
   links are written. Primary signal is now data-page="product" on
   product.html's own <body> instead -- doesn't depend on the URL at all,
   can't be fooled by however a given host happens to be rewriting it. The
   URL check is kept only as a fallback for a hypothetical future page that
   forgets the data-page attribute, and is itself widened to match
   "/product", "/product.html", and either with a trailing slash -- css/
   style.css's own body[data-page="product"] .nav-cta-acquire rule hides
   the button immediately via CSS as a second, independent fallback, so it
   never paints at all even for the brief window before this script's own
   removal runs below, regardless of which signal actually caught it.
   Same "detect the current page, don't duplicate per-page markup"
   approach as js/footer-active-page.js's own "you are here" indicator,
   just applied to the header CTA instead of the footer links -- see that
   file's own comment; it has the identical location.pathname assumption
   and the identical fix. */
(function () {
  const btn = document.querySelector('.nav-cta-acquire');
  if (!btn) return;

  // Strip trailing slash(es) before taking the last segment, so "/product/"
  // matches the same as "/product" -- a bare "/" would otherwise survive
  // the strip as "" and correctly fail to match either name, not
  // accidentally match via some leftover empty segment.
  const lastSegment = location.pathname.replace(/\/+$/, '').split('/').pop();
  const isProductPage = document.body.dataset.page === 'product'
    || lastSegment === 'product' || lastSegment === 'product.html';
  if (!isProductPage) return;

  btn.remove();
})();
