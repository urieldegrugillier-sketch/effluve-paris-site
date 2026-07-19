/* MONARK — site-wide header cart icon + hover mini-preview.
   Depends on js/cart.js (window.MonarkCart) having loaded first. Injects its
   own markup into .nav-links so it doesn't need to be duplicated in every
   page's header HTML.

   The preview dropdown is deliberately appended to <body>, NOT nested inside
   .cart-widget/.site-header: index.html's header uses mix-blend-mode:difference
   for nav legibility over the video canvas, and isolation:isolate + an explicit
   mix-blend-mode:normal on a descendant was not reliably escaping that in every
   rendered case. Living outside the header's subtree entirely removes the
   question altogether -- there is no blend-mode to escape from. It's
   position:fixed and repositioned via JS to sit under the icon on every open. */
(function () {
  const cart = window.MonarkCart;
  if (!cart) return;

  // index.html has a dedicated, always-empty .nav-actions wrapper (its
  // "Acquire" CTA link is a sibling of this wrapper, not nested inside it --
  // see css/style.css's .nav-actions comment) purely so this icon has a
  // stable, right-anchored host independent of whatever else does or doesn't
  // live in .nav-links. Other pages (product, checkout, etc.) have no
  // .nav-actions at all, just a single plain link in .nav-links, so they
  // fall back to the original target.
  const host = document.querySelector('.nav-actions') || document.querySelector('.nav-links') || document.querySelector('.site-nav');
  if (!host) return;

  const widget = document.createElement('div');
  widget.className = 'cart-widget';
  widget.id = 'cart-widget';
  widget.innerHTML = `
    <button type="button" class="cart-icon-link" aria-label="View cart">
      <!-- viewBox is "-1.5 0 20 20", not "0 0 20 20" -- the bag glyph drawn by
           the two paths below (unchanged) has its own true horizontal center
           at x=8.5, not x=10, in their original 0-20 coordinate space (the
           handle arc spans x:6-11, the bag body spans x:3.6-13.4, both
           centered on 8.5 -- confirmed by the path math, not eyeballed).
           Against a same-width 0-20 viewBox that reads as the icon sitting
           ~7.5% left of center, which is exactly the "cart icon looks
           off-center" symptom this was reported as. Shifting the viewBox's
           own min-x by -1.5 (rather than editing the path coordinates, or
           compensating with CSS padding/margin on .cart-icon-link) recenters
           the SAME glyph within the SAME overall 20-unit width precisely,
           from the actual geometry rather than an approximation -- and
           leaves the path data, which product.html/js elsewhere doesn't
           reference, untouched. Vertical centering was already correct
           (glyph's y-center is 10.1 of 20, negligible) so only min-x moved,
           not min-y. -->
      <svg width="20" height="20" viewBox="-1.5 0 20 20" fill="none" aria-hidden="true">
        <path d="M6 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M3.6 7h9.8l-.8 9.6a1 1 0 0 1-1 .9H5.4a1 1 0 0 1-1-.9L3.6 7Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="cart-badge" hidden></span>
    </button>
  `;
  host.appendChild(widget);

  const preview = document.createElement('div');
  preview.className = 'cart-preview';
  preview.id = 'cart-preview';
  // Modal for keyboard/assistive tech while open, same treatment as
  // js/nav-menu.js's own panel (role+aria-modal is the announcement half --
  // see trapTab()/openPreview() below for the actual enforcement). aria-label
  // gives this dialog an accessible name of its own, same reasoning as that
  // file's menu.setAttribute('aria-label', ...).
  preview.setAttribute('role', 'dialog');
  preview.setAttribute('aria-modal', 'true');
  preview.setAttribute('aria-label', 'Shopping cart preview');
  preview.setAttribute('data-i18n-attr', 'aria-label:cartWidget.previewDialogLabel');
  // The close button + body wrapper are created once here, outside of
  // render() below -- render() only ever touches previewBody.innerHTML (on
  // every 'cart:updated'), so a plain preview.innerHTML there would wipe out
  // the close button on every re-render instead of just the cart contents.
  preview.innerHTML = `
    <button type="button" class="cart-preview-close" aria-label="Close cart preview" data-i18n-attr="aria-label:cartWidget.closePreview">&times;</button>
    <div class="cart-preview-body"></div>
  `;
  document.body.appendChild(preview);
  if (window.MonarkI18n) window.MonarkI18n.apply(preview);

  const iconLink = widget.querySelector('.cart-icon-link');
  const badge = widget.querySelector('.cart-badge');
  const previewBody = preview.querySelector('.cart-preview-body');
  const closeBtn = preview.querySelector('.cart-preview-close');

  // Matches the max-width used everywhere else this round for "mobile/
  // tablet" scoping (see css/style.css's .cart-preview-close media query and
  // app.js's isMobileOrTablet) -- evaluated fresh on every tap rather than
  // cached once, since cart-widget.js runs on every page (including ones
  // without app.js) and a cached value would go stale across an orientation
  // change.
  function isMobileOrTablet() {
    return window.matchMedia('(max-width: 1024px)').matches;
  }

  function positionPreview() {
    const r = iconLink.getBoundingClientRect();
    preview.style.top = Math.round(r.bottom + 22) + 'px';
    preview.style.right = Math.round(window.innerWidth - r.right) + 'px';
  }

  let closeTimer = null;
  // Set synchronously by openPreview() and cleared on the next tick (see
  // below) -- lets the outside-click listener further down tell "a click
  // elsewhere on the page that is ITSELF what just opened the preview" (e.g.
  // product.html's Add to Cart button, via flashPreview()) apart from a
  // genuine later click somewhere else while the preview was already open.
  // Without this, that same click bubbles to document AFTER already running
  // whatever handler opened the preview, and the outside-click listener
  // would see "preview is open, click landed outside it" and immediately
  // close it again in the same tick -- which is exactly the regression real
  // testing found: Add to Cart's flash-open (and, by the same mechanism,
  // hover-driven opens that happen to coincide with any click) got closed
  // before it was ever visible.
  let justOpened = false;
  function openPreview() {
    clearTimeout(closeTimer);
    positionPreview();
    preview.classList.add('cart-preview-open');
    justOpened = true;
    setTimeout(() => { justOpened = false; }, 0);
  }
  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => preview.classList.remove('cart-preview-open'), 150);
  }
  // Immediate, not debounced like scheduleClose() -- used by explicit user
  // dismissal (the × button, tap-to-toggle, outside tap/scroll), where a
  // 150ms lingering-open window would read as unresponsive rather than as
  // the hover-forgiveness grace period it's meant to be elsewhere.
  function closePreview() {
    clearTimeout(closeTimer);
    preview.classList.remove('cart-preview-open');
  }

  /* ---------------- Modal focus trap ----------------
     Same overall mechanism as js/nav-menu.js's own trap (see that file's
     "Modal focus trap" comment): every Tab press is intercepted and focus is
     moved explicitly through a computed array, rather than a lighter
     first/last-boundary trap. Unlike that menu, iconLink is deliberately NOT
     one of the array's entries here -- only the preview's own controls
     (+/- buttons, Add Another, clear-all, checkout/view-cart links, close)
     cycle; the icon is the trap's entry point and its Escape/close exit
     destination (see closePreviewAndReturnFocus() below), not a stop inside
     the cycle. Including it caused a real feedback loop when tried: wrapping
     Tab back to iconLink re-fires its own 'focus' listener below (needed for
     the separate "Tab TO the icon from outside opens the preview" case),
     which calls focusFirstPreviewElement() again and immediately yanks focus
     back off the icon onto the close button -- confirmed via direct
     instrumentation (checking document.activeElement a tick after each Tab
     press cycled the icon back out within ~1 frame, every time). Nav-menu's
     hamburger has no equivalent focus-reactive listener, so it never hits
     this; excluding the icon here avoids it entirely instead of adding a
     re-entrancy guard flag just to keep the icon in a cycle nothing actually
     asked for (the task's own list of what should cycle names "close", not
     the icon).

     Unlike the nav menu -- which only ever opens via an explicit click --
     this preview also opens on plain mouse hover (mouseenter), which must
     NOT hijack keyboard focus or trap Tab: a user hovering the cart icon
     while typing elsewhere on the page shouldn't have their next Tab press
     redirected into a preview they never focused. isPreviewEngaged() below
     gates both the Escape-close and Tab-trap handlers on focus actually
     being inside the preview (or on the icon itself) -- true for the
     keyboard-focus and click/tap open paths, false for a bare hover. */
  function getFocusablePreviewElements() {
    return Array.from(preview.querySelectorAll('button, a[href], input'))
      .filter((el) => el.offsetParent !== null);
  }

  function isPreviewEngaged() {
    if (!preview.classList.contains('cart-preview-open')) return false;
    const active = document.activeElement;
    return active === iconLink || preview.contains(active);
  }

  function trapTab(e) {
    if (e.key !== 'Tab') return;
    const focusable = getFocusablePreviewElements();
    if (!focusable.length) return;
    e.preventDefault();
    const currentIndex = focusable.indexOf(document.activeElement);
    let nextIndex;
    if (e.shiftKey) {
      nextIndex = currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1;
    } else {
      nextIndex = currentIndex === -1 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1;
    }
    focusable[nextIndex].focus();
  }

  // Moves focus to the first real control inside the now-open preview --
  // only called from paths that represent a deliberate/keyboard-relevant
  // open (the icon's own 'focus' event, which fires for both Tab-to and
  // click-to; see below), never from mouseenter.
  //
  // Deferred two frames, not one -- same class-change -> transition-start
  // race documented in js/nav-menu.js's openMenu(): .cart-preview's own
  // visibility:hidden->visible flip is driven by a CSS transition
  // (`transition: ...visibility 0.3s`, see css/style.css), and a transition
  // triggered by a class change doesn't start until the frame *after* the
  // one where the style recalc first picks up the new class. A single rAF
  // still finds the element visibility:hidden and browsers refuse to focus
  // an element they consider hidden; two rAFs is the same fix nav-menu.js
  // already relies on for the identical race.
  function focusFirstPreviewElement() {
    const focusable = getFocusablePreviewElements();
    if (!focusable.length) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => focusable[0].focus());
    });
  }

  // Set synchronously around the iconLink.focus() call in
  // closePreviewAndReturnFocus() below -- focus events dispatch synchronously,
  // so this reliably brackets just that one call. Without it, that focus()
  // call fires iconLink's own 'focus' listener (needed for the separate "Tab
  // TO the icon from outside opens the preview" case, wired just below) right
  // back, which re-opens the preview and redirects focus into it again --
  // confirmed via direct instrumentation that Escape/the × button were
  // silently undoing their own close this way, every time.
  let suppressIconFocusOpen = false;

  // Standard dialog-close behavior (ARIA APG): return focus to whatever
  // opened it. Used by the explicit close paths only (× button, Escape) --
  // hover-leave/outside-click/scroll closes (closePreview() on its own,
  // still used by those) have their own natural focus destination already
  // and shouldn't yank focus back to the icon out from under the user.
  function closePreviewAndReturnFocus() {
    closePreview();
    suppressIconFocusOpen = true;
    iconLink.focus();
    suppressIconFocusOpen = false;
  }

  widget.addEventListener('mouseenter', openPreview);
  widget.addEventListener('mouseleave', scheduleClose);
  preview.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  preview.addEventListener('mouseleave', scheduleClose);
  iconLink.addEventListener('focus', () => {
    if (suppressIconFocusOpen) return;
    openPreview();
    focusFirstPreviewElement();
  });
  preview.addEventListener('focusin', openPreview);
  preview.addEventListener('focusout', scheduleClose);

  document.addEventListener('keydown', (e) => {
    if (!isPreviewEngaged()) return;
    if (e.key === 'Escape') { closePreviewAndReturnFocus(); return; }
    trapTab(e);
  });
  window.addEventListener('resize', () => {
    if (preview.classList.contains('cart-preview-open')) positionPreview();
  });

  /* Mobile/tablet: the icon is now a plain button (no separate cart page to
     navigate to -- this preview IS the cart), so tapping it should just
     toggle the preview open/closed. Desktop is untouched: hover already
     shows the preview there without needing a tap.
     A tap's own 'click' fires AFTER a 'focus' event that the same tap
     triggers on this button (real-device- and CDP-touch-confirmed ordering:
     pointerdown -> focus -> click) -- and focus's own listener above already
     calls openPreview(). Reading preview's open/closed state directly inside
     the click handler below would therefore always see "open" (just set by
     that focus, moments earlier), incorrectly closing every tap instead of
     only the ones that were truly already open beforehand. Capturing the
     state on 'pointerdown' -- before focus has fired -- gives the click
     handler the true pre-tap state to decide from instead. */
  let wasOpenBeforeTap = false;
  iconLink.addEventListener('pointerdown', () => {
    wasOpenBeforeTap = preview.classList.contains('cart-preview-open');
  });
  iconLink.addEventListener('click', () => {
    if (!isMobileOrTablet()) return;
    if (wasOpenBeforeTap) closePreview(); // was already open -- tap again dismisses it
    // else: the 'focus' listener above already opened it moments ago.
  });
  closeBtn.addEventListener('click', closePreviewAndReturnFocus);

  /* Tapping/scrolling the page behind the preview used to do nothing --
     nothing in the page listened for it, so the preview only ever closed via
     hover-leave (desktop) or the explicit toggle/× button above (mobile).
     Mirrors how the lightbox/popups elsewhere dismiss on outside-click. Not
     gated to mobile-only: harmless on desktop too (closing an
     already-hover-managed preview early if a stray click lands elsewhere is
     never wrong), so it runs unconditionally rather than duplicating the
     isMobileOrTablet() check for no real benefit.
     justOpened (see openPreview()) guards against the exact regression real
     testing found: a click on something like product.html's Add to Cart
     button (or any other element outside both .cart-widget and
     .cart-preview) that ITSELF calls openPreview()/flashPreview() bubbles up
     to this same listener in the same tick, and without the guard it reads
     as "preview open, click landed outside it" and closes what that very
     click just opened, before it was ever visibly shown. */
  document.addEventListener('click', (e) => {
    if (justOpened) return;
    if (!preview.classList.contains('cart-preview-open')) return;
    if (preview.contains(e.target) || widget.contains(e.target)) return;
    closePreview();
  });
  window.addEventListener('scroll', () => {
    if (preview.classList.contains('cart-preview-open')) closePreview();
  }, { passive: true });

  function money(n) { return '€' + n.toFixed(0); }

  // Small wrapper, not a direct window.MonarkI18n.t reference -- falls back
  // to the English literal when i18n.js hasn't loaded (or on pages that
  // don't include it yet, see this file's header comment on Phase 1 scope),
  // same fallback pattern used everywhere else in this round.
  function t(key, vars) {
    return window.MonarkI18n ? window.MonarkI18n.t(key, vars) : null;
  }

  function render() {
    const items = cart.getCart();
    const count = cart.getCartCount();

    badge.textContent = String(count);
    badge.hidden = count === 0;
    iconLink.setAttribute('aria-label', count > 0
      ? (t('cartWidget.' + (count === 1 ? 'viewCartCount' : 'viewCartCountPlural'), { count }) || `View cart, ${count} item${count === 1 ? '' : 's'}`)
      : (t('cartWidget.viewCart') || 'View cart'));

    if (!items.length) {
      previewBody.innerHTML = `<p class="cart-preview-empty">${t('cartWidget.empty') || 'Your cart is empty.'}</p>`;
      return;
    }

    const item = items[0]; // single product for now
    const subtotal = item.quantity * cart.PRODUCT.price;

    previewBody.innerHTML = `
      <div class="cart-preview-item">
        <img class="cart-preview-thumb" src="${cart.PRODUCT.image}" alt="${cart.PRODUCT.name}" width="2880" height="2880" loading="lazy">
        <div class="cart-preview-info">
          <p class="cart-preview-name">${cart.PRODUCT.name}</p>
          <div class="cart-preview-qty">
            <button type="button" class="cart-qty-btn" data-action="decrement" aria-label="${t('cartWidget.decreaseQty') || 'Decrease quantity'}">&minus;</button>
            <input type="number" class="cart-qty-input" value="${item.quantity}" min="1" aria-label="${t('cartWidget.quantity') || 'Quantity'}">
            <button type="button" class="cart-qty-btn" data-action="increment" aria-label="${t('cartWidget.increaseQty') || 'Increase quantity'}">+</button>
          </div>
          <p class="cart-preview-subtotal">${money(subtotal)}</p>
        </div>
        <button type="button" class="cart-preview-trash" data-action="clear-cart" aria-label="${t('cartWidget.removeItem') || 'Remove item from cart'}">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <path d="M2.8 4.2h9.4M5.6 4.2V2.9c0-.4.3-.7.7-.7h2.4c.4 0 .7.3.7.7v1.3M6 6.9v4.2M9 6.9v4.2M3.6 4.2l.5 7.3c0 .5.5.9 1 .9h4.8c.5 0 .9-.4 1-.9l.5-7.3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div class="cart-preview-actions">
        <button type="button" class="cart-preview-add-another" data-action="add-another">${t('cartWidget.addAnother') || 'Add Another'}</button>
        <a href="checkout.html" class="cart-preview-buy">${t('cartWidget.buyNow') || 'Buy Now'}</a>
      </div>
    `;

    /* stopPropagation on every button here that mutates the cart: writeCart()
       fires 'cart:updated' synchronously, which re-runs render() and replaces
       previewBody.innerHTML *before* this same click has finished bubbling up
       to document. That detaches the clicked button from the DOM mid-bubble,
       so the outside-click listener's `preview.contains(e.target)` check sees
       a node no longer in the tree, reads it as "click landed outside", and
       closes the preview it was never meant to close. These buttons have no
       other reason to bubble, so stopping it here is a clean cut rather than
       a workaround in the document listener. */
    previewBody.querySelector('[data-action="decrement"]').addEventListener('click', (e) => {
      e.stopPropagation();
      cart.updateQuantity(item.quantity - 1);
    });
    previewBody.querySelector('[data-action="increment"]').addEventListener('click', (e) => {
      e.stopPropagation();
      cart.updateQuantity(item.quantity + 1);
    });
    previewBody.querySelector('.cart-qty-input').addEventListener('change', (e) => {
      cart.updateQuantity(parseInt(e.target.value, 10) || 1);
    });
    previewBody.querySelector('[data-action="add-another"]').addEventListener('click', (e) => {
      e.stopPropagation();
      cart.updateQuantity(item.quantity + 1);
    });
    previewBody.querySelector('[data-action="clear-cart"]').addEventListener('click', (e) => {
      e.stopPropagation();
      cart.removeFromCart();
    });
  }

  document.addEventListener('cart:updated', render);
  // render()'s strings are baked into a template string, not plain
  // data-i18n-tagged markup MonarkI18n.apply() could re-walk on its own --
  // re-running the same render() a language switch already reruns on every
  // cart mutation is simpler than duplicating that template a second way.
  document.addEventListener('monark:langchange', render);
  render();

  /* Lets other scripts (e.g. product.html's Add to Cart button) force the
     preview open as visual confirmation, without needing real mouse hover.
     Used to auto-close itself after a fixed duration, but that meant it
     could disappear before the user had even read it -- now it just opens
     like any other trigger and stays open until the user dismisses it
     themselves (× button, outside tap/click, scroll, or the existing
     toggle-on-icon-tap), same as every other way of opening it. */
  function flashPreview() {
    openPreview();
  }

  window.MonarkCartWidget = { flashPreview };
})();
