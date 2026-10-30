/* Homepage's CTA section (index.html, section 006/#acquisition) -- both
   buttons here share the exact same cart (js/cart.js's window.MonarkCart)
   and header cart preview (js/cart-widget.js's window.MonarkCartWidget) as
   product.html's own Add to Cart button, so an item added or bought from
   here is the same cart a visitor sees anywhere else on the site.

   "Buy now" (#cta-buy-now-btn) is a real buy-now: ensures the product is in
   the cart (without adding a second unit if it's already there) then lets
   its own href carry the click to checkout.html -- plain anchor, no
   preventDefault, same pattern the old version of this file used for its
   sessionStorage flag: addToCart() is synchronous and already committed to
   localStorage before the browser's default navigation fires, so this
   works for a normal click AND a modified one (middle-click/ctrl-click
   opening checkout.html in a new tab). checkout.html's own
   js/checkout-page.js already fires GA4's begin_checkout as soon as it
   loads with a non-empty cart, so that event doesn't need firing here too.

   "Add to Cart" (#cta-add-to-cart-btn) mirrors product.html's own
   #add-to-cart-btn exactly: always adds 1 unit (bumping the existing line
   item's quantity if there's already one in the cart -- same addToCart()
   call, which is also where GA4's add_to_cart already fires from), then
   opens the header's cart preview via flashPreview() for feedback. Falls
   back to a brief "Added" label on the button itself on the off chance the
   cart widget isn't on the page. */
(function () {
  const cart = window.MonarkCart;
  if (!cart) return;

  function t(key) { return window.MonarkI18n ? window.MonarkI18n.t(key) : key; }

  const buyBtn = document.getElementById('cta-buy-now-btn');
  if (buyBtn) {
    buyBtn.addEventListener('click', () => {
      const alreadyInCart = cart.getCart().some((item) => item.productId === cart.PRODUCT.id);
      if (!alreadyInCart) cart.addToCart(1);
    });
  }

  const addBtn = document.getElementById('cta-add-to-cart-btn');
  if (addBtn) {
    let revertTimer = null;
    addBtn.addEventListener('click', () => {
      cart.addToCart(1);
      if (window.MonarkCartWidget) {
        window.MonarkCartWidget.flashPreview();
        return;
      }
      clearTimeout(revertTimer);
      const original = addBtn.textContent;
      addBtn.textContent = t('s6.added');
      revertTimer = setTimeout(() => { addBtn.textContent = original; }, 1500);
    });
  }
})();
