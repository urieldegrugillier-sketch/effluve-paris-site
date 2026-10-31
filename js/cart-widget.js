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
  // Mobile/tablet only: tracks "has the icon already been explicitly TAPPED
  // once while the preview was closed" -- separate from the CSS class
  // openPreview()/scheduleClose()/closePreview() already toggle, because
  // that class alone can't tell a real second tap apart from a first one.
  // CONFIRMED (real-device + automated pointer-simulation testing): a touch
  // tap fires a synthetic 'mouseenter' on the target before its own 'click'
  // (same browser compatibility behavior desktop's hover already listens
  // for via widget's own mouseenter handler) -- so by the time THIS click
  // handler runs, the preview may already be marked open from that same
  // tap's own leading mouseenter, making "is the class already there"
  // indistinguishable from a genuine second tap. This flag is only ever set
  // by the click handler's own tap-open branch below (never by
  // openPreview() itself, which hover/focusin also call), so a hover-driven
  // open never counts as "already tapped" -- only two real, separate clicks
  // do. Reset alongside the CSS class everywhere that class comes off, so a
  // closed-then-reopened preview always needs a fresh first tap again.
  let mobileTapOpened = false;
  // Funnels into closePreview() (below) rather than duplicating its body --
  // only the debounce differs, and that now matters even more than it used
  // to: closePreview() is also where a still-open remove-confirmation prompt
  // (see requestRemoveConfirm(), defined further below) gets cleared, and
  // every close path needs that same cleanup, not just the immediate ones.
  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closePreview, 150);
  }
  // Immediate, not debounced like scheduleClose() -- used by explicit user
  // dismissal (the × button, tap-to-toggle, outside tap/scroll), where a
  // 150ms lingering-open window would read as unresponsive rather than as
  // the hover-forgiveness grace period it's meant to be elsewhere.
  function closePreview() {
    clearTimeout(closeTimer);
    preview.classList.remove('cart-preview-open');
    mobileTapOpened = false;
    // A pending "remove MONARK from your cart?" prompt (see
    // requestRemoveConfirm()) never got an explicit answer -- the panel
    // closing itself (× button, outside tap/click, scroll, or hover-leave
    // via scheduleClose() just above) reads as implicit cancellation, same
    // as Escape's own explicit one. Without this, previewBody would still
    // be showing that prompt's markup the next time the panel opens (open
    // paths don't re-render on their own), even though the cart itself was
    // never actually touched.
    if (pendingRemoveConfirm) { pendingRemoveConfirm = false; render(); }
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
     the cycle -- the task's own list of what should cycle names "close",
     not the icon.

     This preview also opens on plain mouse hover (mouseenter), which must
     NOT hijack keyboard focus or trap Tab: a user hovering the cart icon
     while typing elsewhere on the page shouldn't have their next Tab press
     redirected into a preview they never focused. isPreviewEngaged() below
     gates both the Escape-close and Tab-trap handlers on focus actually
     being inside the preview (or on the icon itself) -- true once the
     preview's been explicitly opened (click, tap, or Enter/Space on the
     icon -- see its own click handler further below) and focus has landed
     inside it, false for a bare hover, and ALSO false for simply having
     tabbed to the icon without activating it (a deliberate fix -- that used
     to auto-open the preview and yank focus in as a side effect of mere
     focus, which broke forward Tab navigation for the rest of the page;
     see the click handler's own comment for the full story). */
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
    // Empty-cart state: the close button is the ONLY focusable element (no
    // qty/remove/checkout controls to cycle through -- see render()'s own
    // early return for that state) -- trapping Tab here just forces an
    // explicit Enter/Space on that one button to leave, friction this
    // content-free state doesn't need. Let Tab move through/past it like a
    // normal, non-modal element instead; the existing focusout listener
    // above already schedules the preview closed once focus genuinely
    // leaves it, so nothing further is needed here for that. Cart WITH
    // items always has more than one focusable control (qty -/+, trash,
    // Add Another, Buy Now), so this never touches that path.
    if (focusable.length === 1 && !cart.getCart().length) return;
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
  // only called from paths that represent a deliberate activation (the
  // icon's own 'click' event, which fires for a real click/tap AND for
  // Enter/Space on the focused button; see that handler's own comment
  // further below), never from mouseenter or from merely tabbing to the
  // icon without activating it.
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

  // Standard dialog-close behavior (ARIA APG): return focus to whatever
  // opened it. Used by the explicit close paths only (× button, Escape) --
  // hover-leave/outside-click/scroll closes (closePreview() on its own,
  // still used by those) have their own natural focus destination already
  // and shouldn't yank focus back to the icon out from under the user.
  // No suppress-flag dance needed around this .focus() call (there used to
  // be one) -- iconLink no longer has a 'focus' listener that would react to
  // it, see the click handler further below for why.
  function closePreviewAndReturnFocus() {
    closePreview();
    iconLink.focus();
  }

  widget.addEventListener('mouseenter', openPreview);
  widget.addEventListener('mouseleave', scheduleClose);
  preview.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  preview.addEventListener('mouseleave', scheduleClose);
  preview.addEventListener('focusin', openPreview);
  preview.addEventListener('focusout', scheduleClose);

  document.addEventListener('keydown', (e) => {
    if (!isPreviewEngaged()) return;
    if (e.key === 'Escape') {
      // Cancels the prompt first, same as a real dialog's own Escape
      // behavior -- a second, separate Escape (now that pendingRemoveConfirm
      // is false again) falls through to the normal close.
      if (pendingRemoveConfirm) { cancelRemoveConfirm(); return; }
      closePreviewAndReturnFocus();
      return;
    }
    trapTab(e);
  });
  window.addEventListener('resize', () => {
    if (preview.classList.contains('cart-preview-open')) positionPreview();
  });

  /* BUG FIX: iconLink used to open the preview (and jump focus into it) on
     plain 'focus' -- meaning the instant Tab reached the icon, before the
     user did anything else. Confirmed via a full-page keyboard sweep that
     this silently broke forward Tab navigation for the ENTIRE rest of the
     page: the preview panel is appended to the very end of <body> (after
     #hero, the footer, everything), so force-jumping focus into it landed
     past all of that in DOM order -- and forward Tab can never recover a
     position it's already been jumped past. Every subsequent Tab press was
     left cycling only through whatever else also got appended late (the
     preview panel itself, the cookie banner), wrapping back to the very
     start of the document instead of ever reaching real page content.
     Merely tabbing TO the icon should never have side effects; only an
     actual activation should. 'click' is what handles that now, for both
     directions:
       - A real mouse/touch click or tap (MouseEvent.detail >= 1) keeps
         going through its own branch below (mobile/tablet first-tap-opens/
         second-tap-navigates, desktop navigates straight to checkout).
       - Enter/Space on this focused <button> -- the standard way to
         activate a button by keyboard -- fires this exact same 'click'
         event too, but with detail === 0 (a native <button>'s own way of
         reporting a keyboard-synthesized activation rather than a real
         pointer click, with no separate keydown handling needed here).
         That's the explicit, deliberate "open via keyboard" path this fix
         adds, replacing the removed open-on-mere-focus behavior -- keyboard
         users can still open the preview, just only by actually asking to,
         the same as a click. Deliberately kept as "always open the preview"
         even after the desktop/mobile changes below: hover (desktop's own
         way of revealing the preview to a mouse user) has no keyboard
         equivalent, so Enter/Space on this button is the ONLY way a
         keyboard-only desktop user can ever see cart contents before
         checking out -- routing it straight to checkout.html instead, like
         a real click now does, would remove that entirely rather than just
         changing how it's reached. */
  iconLink.addEventListener('click', (e) => {
    if (e.detail === 0) {
      openPreview();
      focusFirstPreviewElement();
      return;
    }
    // Desktop: navigates straight to checkout instead of toggling the
    // preview via click -- hover (see widget's own mouseenter/mouseleave
    // above) is still there for anyone who wants to glance at the cart
    // first, this just gives a click its own, more direct destination
    // rather than repeating what hover already does.
    if (!isMobileOrTablet()) {
      window.location.href = 'checkout.html';
      return;
    }
    // Mobile/tablet: unchanged first tap (opens the preview, since this IS
    // the cart page there -- no separate page to send a first tap to yet).
    // Second tap, while the preview is ALREADY open, now navigates to
    // checkout instead of just closing it -- the user has already seen the
    // cart at that point (that's what the first tap was for), so a second
    // deliberate tap on the same icon reads as "yes, take me to checkout"
    // rather than "never mind, close this". Checks mobileTapOpened (see its
    // own comment above), NOT the preview's own open CSS class -- the class
    // alone can't tell this real second tap apart from a first tap whose
    // own leading synthetic mouseenter already opened the preview via hover
    // before this same click ever fired.
    if (mobileTapOpened) {
      window.location.href = 'checkout.html';
    } else {
      openPreview();
      focusFirstPreviewElement();
      mobileTapOpened = true;
    }
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

  // Set by the 'cart:quantity-clamped' listener below (js/cart.js dispatches
  // it whenever a requested quantity had to be reduced to fit the live
  // stock ceiling) -- render() shows it as a brief message near the
  // quantity control, then it self-clears after a few seconds. Persists
  // across whatever OTHER 'cart:updated' renders happen to fire meanwhile
  // (e.g. a plain decrement) for the rest of its own short lifetime, same
  // as any other transient toast-style notice would.
  let stockClampNotice = null;
  let stockClampTimer = null;

  // Set by requestRemoveConfirm() (decrement at qty 1, the trash button, or
  // typing 0 into the quantity input -- see their own click/change handlers
  // further below), read by render()'s items branch to swap the normal
  // item row out for an inline Remove/Cancel prompt instead of mutating the
  // cart immediately. Deliberately NOT window.confirm(): that's a native
  // modal, which both steals focus in a way this panel's own focusin/
  // focusout-driven open/close tracking (see restoreFocusAfterRender()'s own
  // comment) can't account for, and -- worse -- blocks JS execution for its
  // own duration, so the focus it steals reads to this panel as "focus left
  // the preview" the instant it opens, scheduling the very close this
  // confirmation exists to prevent before the user ever gets to answer it.
  let pendingRemoveConfirm = false;

  function requestRemoveConfirm() {
    pendingRemoveConfirm = true;
    render();
  }

  // Cancel path only -- the confirm path clears the flag itself right next
  // to the removeFromCart() call it guards (see [data-action="confirm-remove"]
  // below), rather than funneling both through one shared function for a
  // one-line body.
  function cancelRemoveConfirm() {
    pendingRemoveConfirm = false;
    render();
  }

  function stockClampMessageHtml() {
    if (!stockClampNotice) return '';
    return `<p class="cart-preview-stock-message" aria-live="polite">${t('cartWidget.quantityClamped', { max: stockClampNotice.max }) || `Only ${stockClampNotice.max} in stock — quantity adjusted.`}</p>`;
  }

  // If a qty/remove/add-another button inside previewBody is focused when a
  // cart mutation re-renders it, replacing previewBody.innerHTML removes that
  // still-focused node from the DOM -- which makes the browser synchronously
  // fire a native focusout on .preview (focus falls back to <body>), which
  // the focusout listener above reads as "focus left the preview" and
  // schedules it closed via scheduleClose(), same as a genuine tab-away.
  // That's the exact regression this was reported as: clicking any button
  // inside the (already-open) preview closed it ~150ms later even though
  // the click itself never bubbled past previewBody (see those buttons' own
  // e.stopPropagation() above) -- the close was coming from focus loss, not
  // from the outside-click listener. restoreFocusAfterRender() below
  // refocuses the equivalent control once the new markup is in, which fires
  // its own focusin -> openPreview() -> clearTimeout(closeTimer), cancelling
  // that bogus scheduled close the same way any other focusin would.
  function focusDescriptor(el) {
    if (!el) return null;
    if (el.dataset && el.dataset.action) return `[data-action="${el.dataset.action}"]`;
    if (el.classList && el.classList.contains('cart-qty-input')) return '.cart-qty-input';
    return null;
  }

  function restoreFocusAfterRender(hadFocusInPreviewBody, focusedSelector) {
    if (!hadFocusInPreviewBody) return;
    const bySelector = focusedSelector ? previewBody.querySelector(focusedSelector) : null;
    if (bySelector && !bySelector.disabled) { bySelector.focus(); return; }
    // Same control is gone or got disabled by this render (e.g. "+" hitting
    // the stock ceiling, or the trash button clearing the cart entirely) --
    // prefer another still-focusable control within previewBody itself
    // (keeps focus on the actual cart content) before falling back to the
    // close button, which getFocusablePreviewElements() would otherwise
    // return first since it comes before previewBody in the preview's DOM.
    const withinBody = Array.from(previewBody.querySelectorAll('button, a[href], input'))
      .find((el) => el.offsetParent !== null && !el.disabled);
    const next = withinBody || getFocusablePreviewElements()[0] || null;
    if (next) next.focus();
  }

  function render() {
    const items = cart.getCart();
    const count = cart.getCartCount();
    const hadFocusInPreviewBody = previewBody.contains(document.activeElement);
    const focusedSelector = hadFocusInPreviewBody ? focusDescriptor(document.activeElement) : null;

    badge.textContent = String(count);
    badge.hidden = count === 0;
    iconLink.setAttribute('aria-label', count > 0
      ? (t('cartWidget.' + (count === 1 ? 'viewCartCount' : 'viewCartCountPlural'), { count }) || `View cart, ${count} item${count === 1 ? '' : 's'}`)
      : (t('cartWidget.viewCart') || 'View cart'));

    if (!items.length) {
      // product.html IS the "Buy now" destination, so clicking this adds
      // directly instead of navigating there. Detected off
      // body[data-page="product"] (see js/nav-cta-page-aware.js's own
      // comment on why: Cloudflare's clean URLs mean location.pathname is
      // never literally "product.html" in production), never off the URL.
      const isProductPage = document.body.dataset.page === 'product';
      const label = t('cartWidget.emptyCartBuyNow') || 'Buy now';
      const buyNowHtml = isProductPage
        ? `<button type="button" class="cart-preview-buy cart-preview-discover-btn" data-action="buy-now-empty">${label}</button>`
        : `<a href="product.html" class="cart-preview-buy cart-preview-discover-btn" data-action="buy-now-empty">${label}</a>`;
      previewBody.innerHTML = `<p class="cart-preview-empty">${t('cartWidget.empty') || 'Your cart is empty.'}</p>${stockClampMessageHtml()}${buyNowHtml}`;
      if (isProductPage) {
        // Same addToCart(1) call (and the stock-ceiling checks already
        // inside it) as product.html's own Add to Cart/sticky-bar buttons
        // (js/product-page.js) -- no separate stock logic duplicated here.
        // stopPropagation for the same reason every other cart-mutating
        // button in this file has it: writeCart() fires 'cart:updated'
        // synchronously, re-running render() and replacing this very button
        // out from under its own still-bubbling click before it reaches
        // document's outside-click listener.
        previewBody.querySelector('[data-action="buy-now-empty"]').addEventListener('click', (e) => {
          e.stopPropagation();
          cart.addToCart(1);
        });
      } else {
        // Same one-shot sessionStorage flag js/cta-buy-now.js's homepage CTA
        // sets, consumed by the SAME existing code in js/product-page.js
        // (adds 1 unit, flashes the cart preview open) -- not duplicated
        // here. Plain anchor, not intercepted: setItem() is synchronous, so
        // it's already written before the browser's own default navigation
        // to product.html proceeds.
        previewBody.querySelector('[data-action="buy-now-empty"]').addEventListener('click', () => {
          sessionStorage.setItem('autoBuyNow', '1');
        });
      }
      restoreFocusAfterRender(hadFocusInPreviewBody, focusedSelector);
      return;
    }

    const item = items[0]; // single product for now

    // Confirming would take the cart to 0 -- see requestRemoveConfirm()'s
    // own comment on why this is inline markup rather than window.confirm().
    // Swaps the entire item row out for the prompt rather than showing it
    // alongside the still-live qty/trash controls, so there's nothing left
    // to interact with except answering it. Reuses .cart-preview-empty
    // (same muted centered body copy as the empty-cart message) and
    // .cart-preview-actions/.cart-preview-buy/.cart-preview-add-another
    // (same flex row this file's other two-button pairs already use), but
    // with Cancel -- not Remove -- taking the gold-filled/prominent
    // treatment: this is a destructive confirmation, so the safe default
    // (not the one that removes the item) is the one that should read as
    // the obvious action and catch an accidental Enter/Space. Cancel is
    // also first in the DOM for that same reason -- restoreFocusAfterRender()
    // below falls back to the first focusable control in previewBody
    // whenever the control that originally had focus (decrement/trash/the
    // qty input) no longer exists in this new markup, which on first
    // showing this prompt is always the case, so putting Cancel first here
    // is what actually lands initial focus on it, no separate focus() call
    // needed.
    if (pendingRemoveConfirm) {
      previewBody.innerHTML = `
        <p class="cart-preview-empty" aria-live="polite">${t('cartWidget.confirmRemoveText') || 'Remove MONARK from your cart?'}</p>
        <div class="cart-preview-actions">
          <button type="button" class="cart-preview-buy" data-action="confirm-cancel">${t('cartWidget.confirmCancelBtn') || 'Cancel'}</button>
          <button type="button" class="cart-preview-add-another" data-action="confirm-remove">${t('cartWidget.confirmRemoveBtn') || 'Remove'}</button>
        </div>
      `;
      // Same stopPropagation reasoning as every other button in this file
      // that replaces previewBody.innerHTML from inside its own click
      // handler (see the comment on the decrement/increment/etc. listeners
      // below) -- confirm-remove mutates the cart synchronously via
      // removeFromCart(), confirm-cancel calls render() directly; either
      // way this exact button is gone from the DOM before its own click
      // finishes bubbling, which the outside-click listener would otherwise
      // misread as "landed outside the preview".
      previewBody.querySelector('[data-action="confirm-remove"]').addEventListener('click', (e) => {
        e.stopPropagation();
        pendingRemoveConfirm = false;
        cart.removeFromCart();
      });
      previewBody.querySelector('[data-action="confirm-cancel"]').addEventListener('click', (e) => {
        e.stopPropagation();
        cancelRemoveConfirm();
      });
      restoreFocusAfterRender(hadFocusInPreviewBody, focusedSelector);
      return;
    }

    const subtotal = item.quantity * cart.PRODUCT.price;
    // Infinity (stock not loaded yet, see js/cart.js's getStockCeiling())
    // renders as no max attribute at all -- an empty string is how you omit
    // a numeric attribute in this template, not "Infinity" as a literal.
    const stockMax = cart.getStockRemaining ? cart.getStockRemaining() : Infinity;
    const atStockMax = item.quantity >= stockMax;

    previewBody.innerHTML = `
      <div class="cart-preview-item">
        <img class="cart-preview-thumb" src="${cart.PRODUCT.image}" alt="${cart.PRODUCT.name}" width="2880" height="2880" loading="lazy">
        <div class="cart-preview-info">
          <p class="cart-preview-name">${cart.PRODUCT.name}</p>
          <div class="cart-preview-qty">
            <button type="button" class="cart-qty-btn" data-action="decrement" aria-label="${t('cartWidget.decreaseQty') || 'Decrease quantity'}">&minus;</button>
            <input type="number" class="cart-qty-input" value="${item.quantity}" min="1"${Number.isFinite(stockMax) ? ` max="${stockMax}"` : ''} aria-label="${t('cartWidget.quantity') || 'Quantity'}">
            <button type="button" class="cart-qty-btn" data-action="increment" aria-label="${t('cartWidget.increaseQty') || 'Increase quantity'}"${atStockMax ? ' disabled' : ''}>+</button>
          </div>
          <p class="cart-preview-subtotal">${money(subtotal)}</p>
          ${stockClampMessageHtml()}
        </div>
        <button type="button" class="cart-preview-trash" data-action="clear-cart" aria-label="${t('cartWidget.removeItem') || 'Remove item from cart'}">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <path d="M2.8 4.2h9.4M5.6 4.2V2.9c0-.4.3-.7.7-.7h2.4c.4 0 .7.3.7.7v1.3M6 6.9v4.2M9 6.9v4.2M3.6 4.2l.5 7.3c0 .5.5.9 1 .9h4.8c.5 0 .9-.4 1-.9l.5-7.3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div class="cart-preview-actions">
        <button type="button" class="cart-preview-add-another" data-action="add-another"${atStockMax ? ' disabled' : ''}>${t('cartWidget.addAnother') || 'Add Another'}</button>
        <a href="checkout.html" class="cart-preview-buy">${t('cartWidget.buyNow') || 'Buy Now'}</a>
      </div>
      <p class="cart-timer-drawer" id="cart-timer-drawer" hidden></p>
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
    // Decrementing from 1 (or typing 0 below) would take this single-item
    // cart's total to 0 -- same "would this zero the cart" condition the
    // task scoped the confirmation to, so only this exact edge routes
    // through requestRemoveConfirm() instead of updateQuantity(); 3 -> 2
    // and every other decrement stays immediate.
    previewBody.querySelector('[data-action="decrement"]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.quantity - 1 <= 0) { requestRemoveConfirm(); return; }
      cart.updateQuantity(item.quantity - 1);
    });
    previewBody.querySelector('[data-action="increment"]').addEventListener('click', (e) => {
      e.stopPropagation();
      cart.updateQuantity(item.quantity + 1);
    });
    previewBody.querySelector('.cart-qty-input').addEventListener('change', (e) => {
      // parseInt('0', 10) is 0, which is falsy -- the pre-existing `|| 1`
      // fallback below (kept for an empty/invalid value, e.g. clearing the
      // field entirely) would otherwise silently coerce a deliberately
      // typed "0" back up to 1 before this ever reaches the same
      // would-zero-the-cart check the other two triggers use. Checked
      // separately, against the raw parse, so that fallback still only
      // ever fires for NaN.
      const parsed = parseInt(e.target.value, 10);
      if (parsed === 0) { requestRemoveConfirm(); return; }
      cart.updateQuantity(parsed || 1);
    });
    previewBody.querySelector('[data-action="add-another"]').addEventListener('click', (e) => {
      e.stopPropagation();
      cart.updateQuantity(item.quantity + 1);
    });
    // Removing the item line always zeroes this single-item cart's total,
    // regardless of its current quantity -- unlike decrement/the qty input,
    // there's no "stays immediate" case for this button to preserve.
    previewBody.querySelector('[data-action="clear-cart"]').addEventListener('click', (e) => {
      e.stopPropagation();
      requestRemoveConfirm();
    });

    // #cart-timer-drawer was just (re)created above -- paint it immediately
    // from the current state rather than leaving it empty/hidden for up to a
    // second until window.MonarkCartTimer's own next tick finds it.
    if (window.MonarkCartTimer) renderCartTimer(window.MonarkCartTimer.getState());

    restoreFocusAfterRender(hadFocusInPreviewBody, focusedSelector);
  }

  // Shared by the per-second subscribe() tick below and the manual call
  // right after render() rebuilds #cart-timer-drawer above -- looked up by
  // id fresh every time (not cached) since render() replacing
  // previewBody.innerHTML tears down and recreates this element on every
  // cart mutation. Returns silently when it's not there at all (empty-cart
  // and remove-confirmation branches of render() don't include it -- the
  // countdown is only ever shown alongside real cart contents).
  function cartTimerContentHtml(state) {
    const mmss = window.MonarkCartTimer.formatMMSS(state.seconds);
    return `<span class="promo-countdown-label">${t('cartTimer.before') || 'You have'}</span> <span class="promo-countdown-value">${mmss}</span> <span class="promo-countdown-label">${t('cartTimer.after') || 'to complete your order'}</span>`;
  }
  function renderCartTimer(state) {
    const el = document.getElementById('cart-timer-drawer');
    if (!el) return;
    el.hidden = !state.visible;
    el.innerHTML = state.visible ? cartTimerContentHtml(state) : '';
  }
  if (window.MonarkCartTimer) window.MonarkCartTimer.subscribe(renderCartTimer);
  // Rebuilds immediately on a language switch rather than waiting for the
  // next second-tick -- same reasoning as render()'s own langchange listener
  // further below, just scoped to this one element instead of a full
  // previewBody rebuild.
  document.addEventListener('monark:langchange', () => {
    if (window.MonarkCartTimer) renderCartTimer(window.MonarkCartTimer.getState());
  });

  document.addEventListener('cart:updated', render);
  // js/cart.js dispatches this whenever addToCart()/updateQuantity() had to
  // reduce a requested quantity to fit the live stock ceiling -- the SAME
  // call also fires 'cart:updated' (above), so render() already runs right
  // after this; re-rendering here too just means the very first paint of
  // the notice doesn't have to wait on that separate listener's own turn.
  // Auto-clears after 4s (re-rendering once more to drop it) rather than
  // sitting there indefinitely.
  document.addEventListener('cart:quantity-clamped', (e) => {
    stockClampNotice = e.detail;
    clearTimeout(stockClampTimer);
    stockClampTimer = setTimeout(() => { stockClampNotice = null; render(); }, 4000);
    render();
  });
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
