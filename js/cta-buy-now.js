/* Homepage's gold "Buy now" CTA (index.html, section 006/#acquisition) --
   links straight to product.html like any other .cta-button, but first
   sets a one-shot sessionStorage flag product.html's own js/product-page.js
   checks and consumes on load, auto-adding 1 unit and opening the cart
   preview so the visitor lands already-in-cart instead of having to click
   Add to Cart again. sessionStorage, not a URL param: survives the
   navigation without needing product.html to parse/strip anything from its
   own URL, and js/product-page.js removes it immediately on read so a
   refresh or back/forward return to product.html never re-adds. Plain
   anchor, not intercepted/preventDefault()-ed -- setItem() is synchronous,
   so it's already written before the browser's own default navigation
   proceeds. */
(function () {
  const btn = document.getElementById('cta-buy-now-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    sessionStorage.setItem('autoBuyNow', '1');
  });
})();
