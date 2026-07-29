/* MONARK — cart state (client-side only, localStorage-backed, no backend).
   Exposes window.MonarkCart. Every mutation fires a 'cart:updated' event on
   document so any page's UI can react without polling. */
(function (global) {
  const STORAGE_KEY = 'monark_cart';

  /* Single product for now, but cart is structured as an array of
     { productId, quantity } line items so adding a second product later is
     just another entry, not a data-model rewrite. */
  const PRODUCT = {
    id: 'monark-edp-100ml',
    name: 'MONARK Eau de Parfum — 100ml',
    price: 149,
    /* FAKE/PLACEHOLDER pre-discount price -- same 189 already shown (as a
       purely cosmetic struck-through figure) on product.html's own price
       display. Kept here too now that checkout.html's order summary needs
       the same number to compute its "Limited-Time Offer (-21%)" savings
       line and the struck-through original total, so both pages read from
       one source instead of two separately-typed copies of "189" that
       could drift apart. */
    originalPrice: 189,
    image: 'assets/images/02_fully_edited.webp'
  };

  function readCart() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const items = raw ? JSON.parse(raw) : [];
      return Array.isArray(items) ? items : [];
    } catch (e) {
      return [];
    }
  }

  function writeCart(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    document.dispatchEvent(new CustomEvent('cart:updated', { detail: { items } }));
    return items;
  }

  function getCart() {
    return readCart();
  }

  function addToCart(qty) {
    qty = Math.max(1, Math.floor(qty) || 1);
    const items = readCart();
    const existing = items.find((item) => item.productId === PRODUCT.id);
    if (existing) {
      existing.quantity += qty;
    } else {
      items.push({ productId: PRODUCT.id, quantity: qty });
    }
    return writeCart(items);
  }

  function updateQuantity(qty) {
    qty = Math.floor(qty);
    if (!qty || qty <= 0) return removeFromCart();
    const items = readCart();
    const existing = items.find((item) => item.productId === PRODUCT.id);
    if (!existing) return items;
    existing.quantity = qty;
    return writeCart(items);
  }

  function removeFromCart() {
    const items = readCart().filter((item) => item.productId !== PRODUCT.id);
    return writeCart(items);
  }

  function getCartTotal() {
    return readCart().reduce((sum, item) => sum + item.quantity * PRODUCT.price, 0);
  }

  /* Same shape as getCartTotal(), just against PRODUCT.originalPrice instead
     of PRODUCT.price -- what the cart would total at the pre-discount price,
     used by checkout.html to show the site-wide -21% savings and the
     struck-through "if you paid full price" total. */
  function getOriginalCartTotal() {
    return readCart().reduce((sum, item) => sum + item.quantity * PRODUCT.originalPrice, 0);
  }

  /* The site-wide -21% offer's savings -- already baked into PRODUCT.price
     itself (not a separate deduction applied on top of getCartTotal()), so
     this is purely informational for display, distinct from
     getDiscountAmount()'s promo-code discount below. */
  function getSiteDiscountAmount() {
    return getOriginalCartTotal() - getCartTotal();
  }

  function getCartCount() {
    return readCart().reduce((sum, item) => sum + item.quantity, 0);
  }

  function clearCart() {
    return writeCart([]);
  }

  /* ---------------- Promo codes ----------------
     Validated server-side (supabase/functions/validate-promo-code, backed by
     the public.promo_codes table) rather than against a hardcoded local map
     -- no discount rate (or which strings even count as valid codes) ships
     in client-side code anymore. supabase/functions/create-checkout-session
     independently re-checks the same table when it computes the actual
     Stripe charge, so this module is never trusted for the real amount --
     only for the UI preview (the success message, the displayed total).
     The applied code AND its server-confirmed rate are persisted together as
     one JSON blob in localStorage (not the cart items array), so they
     survive quantity changes and persist into checkout.html same as the cart
     contents do, and so every synchronous read below (getPromoDiscountRate/
     getDiscountAmount/getFinalTotal -- called constantly, e.g. on every
     render) can stay synchronous without a network round-trip on every read;
     only applyPromoCode() itself needs to await the server. */
  const PROMO_STORAGE_KEY = 'monark_promo_code';

  function readAppliedPromo() {
    try {
      const raw = localStorage.getItem(PROMO_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed.code === 'string' && typeof parsed.rate === 'number' ? parsed : null;
    } catch (e) {
      // Covers a stale pre-migration value too (this key used to hold a bare
      // code string, not JSON) -- treated the same as "nothing applied"
      // rather than thrown, matching readCart()'s own malformed-data handling.
      return null;
    }
  }

  function getAppliedPromoCode() {
    const applied = readAppliedPromo();
    return applied ? applied.code : null;
  }

  async function applyPromoCode(rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code || !global.MonarkSupabase) return { ok: false };
    let data, error;
    try {
      ({ data, error } = await global.MonarkSupabase.functions.invoke('validate-promo-code', { body: { code } }));
    } catch (e) {
      return { ok: false };
    }
    if (error || !data || !data.valid || typeof data.discountPercent !== 'number') return { ok: false };
    const rate = data.discountPercent / 100;
    localStorage.setItem(PROMO_STORAGE_KEY, JSON.stringify({ code, rate }));
    document.dispatchEvent(new CustomEvent('cart:updated', { detail: { items: readCart() } }));
    return { ok: true, code, rate };
  }

  function removePromoCode() {
    localStorage.removeItem(PROMO_STORAGE_KEY);
    document.dispatchEvent(new CustomEvent('cart:updated', { detail: { items: readCart() } }));
  }

  function getPromoDiscountRate() {
    const applied = readAppliedPromo();
    return applied ? applied.rate : 0;
  }

  function getDiscountAmount() {
    return getCartTotal() * getPromoDiscountRate();
  }

  function getFinalTotal() {
    return getCartTotal() - getDiscountAmount();
  }

  global.MonarkCart = {
    PRODUCT,
    addToCart,
    updateQuantity,
    removeFromCart,
    getCart,
    getCartTotal,
    getOriginalCartTotal,
    getSiteDiscountAmount,
    getCartCount,
    clearCart,
    getAppliedPromoCode,
    applyPromoCode,
    removePromoCode,
    getPromoDiscountRate,
    getDiscountAmount,
    getFinalTotal
  };
})(window);
