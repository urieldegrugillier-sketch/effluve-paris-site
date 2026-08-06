(function () {
  function t(key, vars) { return window.MonarkI18n ? window.MonarkI18n.t(key, vars) : key; }

  const progressEl = document.getElementById('stock-progress');
  const labelEl = document.getElementById('stock-label');
  const fillEl = document.getElementById('stock-fill');

  // Static fallback (32/500) baked into the markup itself, re-rendered
  // through this same function so the bar width/label/aria stay in sync
  // with whatever numbers are currently showing -- keeps the page looking
  // correct even before SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY
  // (js/supabase-client.js) are filled in with real values, or if the live
  // read below ever fails.
  let remaining = 32;
  let total = 500;
  function renderStock() {
    if (!progressEl || !labelEl || !fillEl || !total) return;
    const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
    fillEl.style.width = pct + '%';
    progressEl.setAttribute('aria-valuemax', total);
    progressEl.setAttribute('aria-valuenow', remaining);
    labelEl.textContent = t('product.stockLabel', { count: remaining });
  }
  renderStock();
  document.addEventListener('monark:langchange', renderStock);

  // Live read from public.products (publicly readable per its RLS policy) --
  // single-row table for now (one MONARK edition), so the first row is the
  // right one with no id/name filter needed. Deliberately NOT decremented
  // from here on purchase: that needs a server-side function (e.g. a
  // Postgres RPC/Edge Function doing an atomic decrement) to avoid a race
  // between two simultaneous buyers double-spending the same unit -- a
  // follow-up task, not attempted here.
  if (window.MonarkSupabase) {
    window.MonarkSupabase
      .from('products')
      .select('stock_remaining, stock_total')
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error || !data) {
          if (error) console.error('product stock read:', error.message);
          return;
        }
        if (data.stock_remaining !== null && data.stock_remaining !== undefined) remaining = data.stock_remaining;
        if (data.stock_total !== null && data.stock_total !== undefined) total = data.stock_total;
        renderStock();
      });
  }

  const addBtn = document.getElementById('add-to-cart-btn');
  if (!addBtn || !window.MonarkCart) return;

  // Button label never changes -- clicking repeatedly to add multiple units
  // should never look ambiguous. Confirmation is the header cart preview
  // briefly opening instead (same panel shown on hover). Quantity beyond 1 is
  // adjusted afterward in that preview (its own +/- control), not chosen here.
  addBtn.addEventListener('click', () => {
    window.MonarkCart.addToCart(1);
    if (window.MonarkCartWidget) window.MonarkCartWidget.flashPreview();
  });
  // "Buy Now" used to live here (add 1, go straight to checkout.html) --
  // removed entirely, replaced everywhere by the real Payment Request
  // Button (Apple Pay/Google Pay/Link, see the standalone IIFE below).
})();

/* ---------------- Sticky buy bar (mobile/tablet only) ----------------
   Hermès-style fixed bottom bar -- see css/shop.css's own @media (max-width:
   768px) block for why this never shows on desktop regardless of the scroll
   listener below still running there. Separate IIFE from the one above:
   this doesn't depend on (or want to be short-circuited by) that one's own
   `if (!addBtn || !window.MonarkCart) return;` guard. */
(function () {
  const bar = document.getElementById('shop-sticky-bar');
  const cart = window.MonarkCart;
  const footer = document.querySelector('.shop-footer');
  if (!bar || !cart || !footer) return;

  // Visible from page load / the very top of scroll -- no longer gated on
  // scroll position past the CTA row at all (that measurement, and the
  // getBoundingClientRect() call behind it, is gone entirely). Only the
  // footer-visibility check remains, to keep the bar from covering the
  // footer once it's scrolled into view -- see FOOTER_HIDE_BUFFER's own
  // comment below for the one non-obvious part of that.
  let ticking = false;

  function updateBarVisibility() {
    ticking = false;
    const viewportHeight = window.innerHeight;
    // FOOTER_HIDE_BUFFER: at the page's absolute max scroll position, the
    // footer's top edge lands EXACTLY at (viewportHeight - its own height) --
    // confirmed live, this meant a strict `<` never fired there (equal, not
    // less), leaving the bar visibly sitting on the footer with nowhere left
    // to scroll away from it. A few px of buffer hides it slightly before
    // that exact boundary instead of exactly at (or past) it. Hiding only
    // once the footer is FULLY on screen (both its top AND bottom edges
    // within the viewport), not the instant any sliver of it appears, is
    // what gives the fade transition enough scroll distance to actually
    // complete before the bar's told to hide again (confirmed live via
    // touch-drag scrolling in an earlier round).
    const FOOTER_HIDE_BUFFER = 12;
    const footerRect = footer.getBoundingClientRect();
    const footerVisible = footerRect.top < viewportHeight - footerRect.height + FOOTER_HIDE_BUFFER;
    bar.classList.toggle('shop-sticky-bar-visible', !footerVisible);
  }

  function onScrollOrResize() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateBarVisibility);
  }

  window.addEventListener('scroll', onScrollOrResize, { passive: true });
  window.addEventListener('resize', onScrollOrResize);
  // Checked once up front too -- this is what actually shows the bar
  // immediately on a normal top-of-page load (no 'scroll' event fires on
  // its own until the user scrolls), and also covers a page load that
  // starts already scrolled (browser-restored scroll position on
  // reload/back-navigation).
  updateBarVisibility();

  const stickyAddBtn = document.getElementById('sticky-add-to-cart-btn');
  stickyAddBtn.addEventListener('click', () => {
    cart.addToCart(1);
    if (window.MonarkCartWidget) window.MonarkCartWidget.flashPreview();
  });
})();

/* ---------------- Stripe Payment Request Button (Apple Pay/Google Pay/Link) ----------------
   One real PaymentRequest, mounted into TWO Elements -- the main content
   area's own row (next to Add to Cart, every breakpoint, replacing the old
   standalone "Buy Now" button) and the sticky mobile bar's. Stripe supports
   creating multiple paymentRequestButton Elements off the same
   PaymentRequest instance; clicking either one fires the exact same
   'paymentmethod' handler below, so there's only ever one place this needs
   to be gotten right. No longer gated behind the 768px breakpoint -- this
   now needs to run on desktop too, for the main content area's own button. */
(function () {
  const cart = window.MonarkCart;
  const mainContainer = document.getElementById('main-payment-request-button');
  const stickyContainer = document.getElementById('sticky-payment-request-button');
  if (!cart || !window.MonarkStripe || !window.MonarkSupabase || (!mainContainer && !stickyContainer)) return;

  function prLocale() {
    return window.MonarkI18n && window.MonarkI18n.getLang() === 'fr' ? 'fr' : 'en';
  }

  function t(key, vars) { return window.MonarkI18n ? window.MonarkI18n.t(key, vars) : key; }

  // Whatever's already in the cart, or 1 unit if it's currently empty (there
  // has to be something to buy) -- matches "Add to Cart"'s own always-adds-1
  // behavior for a fresh visitor, without silently padding an extra unit
  // onto a cart that already has some in it.
  function currentQuantity() {
    const items = cart.getCart();
    return items.length ? items[0].quantity : 1;
  }

  function currentAmountCents() {
    const items = cart.getCart();
    const total = items.length ? cart.getFinalTotal() : cart.PRODUCT.price;
    return Math.round(total * 100);
  }

  const paymentRequest = window.MonarkStripe.paymentRequest({
    country: 'FR',
    currency: 'eur',
    total: { label: cart.PRODUCT.name, amount: currentAmountCents() },
    // Needed to attach this order to an email (see the 'paymentmethod'
    // handler's own comment on why) -- Apple Pay/Google Pay/Link all supply
    // this from the payer's own saved wallet info, no extra typing for them.
    requestPayerName: true,
    requestPayerEmail: true
  });

  // BUG FIX: the amount above used to be computed once at page load and
  // never touched again -- since the cart is normally still empty at that
  // point, it fell back to a single unit's price and STAYED there
  // regardless of how many units ended up in the cart by the time the
  // button was actually clicked (Apple Pay always charged for 1, no matter
  // the real quantity). Re-synced here on every cart change instead, so the
  // sheet's own on-screen total never lies about what's about to be
  // charged. The Edge Function still independently computes and charges the
  // authoritative server-side amount (see create-checkout-session) -- this
  // is what keeps the sheet's displayed total matching that.
  function syncTotal() {
    paymentRequest.update({ total: { label: cart.PRODUCT.name, amount: currentAmountCents() } });
  }
  document.addEventListener('cart:updated', syncTotal);

  // ---------------- Keyboard-accessible fallback button ----------------
  // CONFIRMED (prior rounds' investigation): once Tab moves focus into
  // Stripe's paymentRequestButton iframe, it's a genuine dead end for
  // keyboard users -- the iframe is cross-origin, so no code on this page
  // can see or intercept any key event once focus is inside it. That's an
  // upstream Stripe.js limitation (see the open GitHub issues this
  // codebase's own history cites), not something fixable by changing how
  // the iframe itself is built or styled. tabIndex = -1 on the iframe alone
  // doesn't reliably keep real Chrome from still landing focus inside it
  // either (confirmed live) -- so this real <button> takes the iframe's
  // place in the Tab sequence instead, positioned as an absolute overlay
  // exactly on top of it (see .shop-payment-request-fallback in
  // css/shop.css): invisible and inert for mouse/touch users by default
  // (opacity:0, pointer-events:none), who still see and click Stripe's own
  // rendered button underneath completely unchanged, and only becomes
  // visible -- with its own labeled border -- once keyboard focus actually
  // lands on it. Activating it (Enter/Space, native <button> semantics, no
  // extra key handling needed here) calls paymentRequest.show() directly:
  // Stripe's own documented way to trigger the exact same native Apple
  // Pay/Google Pay/Link sheet from a custom button instead of its own
  // Element -- full functional parity, not a dead-end substitute.
  //
  // BUG FIX: an earlier version of this fix caught focus REACTIVELY (a
  // 'focus' listener on the iframe, bouncing it onto this button once
  // already inside) -- functional, but visibly a two-step Tab: focus (and
  // Stripe's own rendered button) flashed into view for a frame before the
  // bounce redirected it, instead of one clean stop. preventTabIntoIframe()
  // below fixes that by intercepting the Tab *keydown* itself, on whichever
  // element currently has focus, BEFORE the browser ever resolves and moves
  // focus anywhere -- e.preventDefault() there stops that resolution
  // outright, so the iframe is never entered even momentarily, in either
  // direction (Tab forward or Shift+Tab backward). The reactive 'focus'
  // listener (still wired in mountButtons() below) stays only as a
  // defensive fallback for any path preventTabIntoIframe() doesn't cover --
  // it should never actually fire in ordinary Tab navigation once this is
  // in place.
  //
  // Built and wired up fresh inside mountButtons() below (not once here at
  // the top) -- confirmed live that el.mount(container) clears out
  // whatever was already in `container`, so a button appended here before
  // the first mount ever happened was gone by the time canMakePayment()
  // resolved and mount() actually ran. mountFallbackButton() below reuses
  // an existing button instead of creating a new one if `container` still
  // has one from a previous mount (harmless either way, just avoids
  // needless churn on every language-switch remount).
  const fallbackButtons = [];
  function mountFallbackButton(container) {
    let btn = container.querySelector('.shop-payment-request-fallback');
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shop-payment-request-fallback';
    btn.textContent = t('product.paymentRequestFallback');
    btn.addEventListener('click', () => paymentRequest.show());
    container.appendChild(btn);
    fallbackButtons.push(btn);
    return btn;
  }
  document.addEventListener('monark:langchange', () => {
    fallbackButtons.forEach((btn) => { btn.textContent = t('product.paymentRequestFallback'); });
  });

  // Every element on the page the browser would actually consider a
  // sequential Tab stop, in DOM order -- deliberately includes <iframe>
  // explicitly (querySelectorAll needs it listed; there's no way to select
  // "anything focusable" generically) and deliberately does NOT filter out
  // tabIndex === -1 elements, since that's the exact case this exists to
  // catch (the Stripe iframe keeps tabIndex=-1 too, see mountButtons()
  // below, yet Chrome still visits it -- confirmed live -- so a filter
  // based on what tabIndex=-1 is supposed to mean would just hide the one
  // element this needs to find). getBoundingClientRect() width/height (not
  // offsetParent, which is unconditionally null for position:fixed
  // elements regardless of visibility -- and the sticky bar this also
  // needs to cover is exactly that, see .shop-sticky-bar in css/shop.css)
  // is what actually determines "visible" here.
  function getPageFocusableElements() {
    return Array.from(document.querySelectorAll('a[href], button, input, textarea, select, summary, iframe')).filter((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    });
  }

  // The actual fix (see createFallbackButton()'s -- now mountFallbackButton()'s
  // -- own comment above for the full reasoning): on every Tab press,
  // checks whether the element sequential navigation is ABOUT to move focus
  // to (in whichever direction, forward or Shift+Tab-backward) is one of
  // our own Payment Request Button iframes -- and if so, redirects straight
  // to that same container's fallback button instead, via
  // e.preventDefault() on the keydown that would have caused the move. This
  // runs BEFORE the browser resolves that move at all, so the iframe is
  // never focused even momentarily -- no flash of Stripe's own rendered
  // button, one clean Tab stop either direction.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = getPageFocusableElements();
    const currentIndex = focusable.indexOf(document.activeElement);
    if (currentIndex === -1) return;
    const target = focusable[e.shiftKey ? currentIndex - 1 : currentIndex + 1];
    if (!target || target.tagName !== 'IFRAME') return;
    const container = [mainContainer, stickyContainer].find((c) => c && c.contains(target));
    if (!container) return;
    const fallbackBtn = container.querySelector('.shop-payment-request-fallback');
    if (!fallbackBtn) return;
    e.preventDefault();
    fallbackBtn.focus();
  });

  const mountedButtons = []; // [{ container, el }] -- rebuilt on every mountButtons() call (see langchange below)

  function mountButtons() {
    mountedButtons.forEach(({ el }) => el.unmount());
    mountedButtons.length = 0;

    // BUG FIX: Stripe only allows ONE paymentRequestButton Element per
    // Elements *group* -- reusing a single stripe.elements(...) instance for
    // both containers threw "Can only create one Element of type
    // paymentRequestButton" (confirmed live) and broke the whole script,
    // including everything after it in this IIFE. Each button needs its own
    // Elements group; both groups can still share the one `paymentRequest`
    // object above, so clicking either fires the same 'paymentmethod'
    // handler below regardless of which group rendered it.
    // theme: 'light' -- Stripe's paymentRequestButton style API only takes
    // 'dark' (default) | 'light' | 'light-outline' (confirmed against
    // Stripe's own type definitions), not an arbitrary color; 'light' is
    // the solid-white variant.
    //
    // type: 'default' -- bare logo/wordmark only, no "Buy with"/"Pay with"
    // text prefix ('buy' shows that longer localized variant instead;
    // switched back to 'default' per explicit request). Whichever type is
    // used, it localizes automatically from the `locale` passed to
    // elements() below -- see that same call's own reasoning on why each
    // button needs its own Elements group.
    const PR_BUTTON_TYPE = 'default';
    // height values below match #add-to-cart-btn's/#sticky-add-to-cart-btn's
    // own real rendered height exactly (confirmed live via
    // getBoundingClientRect(): 52.1875px main / 43.1875px sticky) -- was
    // 50px/44px, close but not exact, which read as the Payment Request
    // Button being visibly shorter/more secondary next to Add to Cart
    // instead of a matched pair at the same height.
    //
    // NOT pushed any higher than this -- tested live at height:'80px' (both
    // this option AND .shop-payment-request-button's own CSS height, which
    // has to move together or the CSS just clips the taller iframe): Stripe
    // genuinely rendered the button box at the full 80px, no silent
    // clamping, but the Link/Google Pay logo+wordmark INSIDE it stayed
    // exactly the same fixed size -- it didn't scale up at all, just sat in
    // more empty padding, looking worse than at 52px, not better. That's
    // the wallet's own button content having a fixed internal size
    // independent of the height option, not a CSS/config problem on this
    // page -- 52px/43px (matched to Add to Cart) is already the best
    // available value, not an arbitrary stopping point short of some
    // higher number that would help.
    if (mainContainer) {
      const mainElements = window.MonarkStripe.elements({ locale: prLocale() });
      mountedButtons.push({
        container: mainContainer,
        el: mainElements.create('paymentRequestButton', { paymentRequest, style: { paymentRequestButton: { type: PR_BUTTON_TYPE, theme: 'light', height: '52px' } } })
      });
    }
    if (stickyContainer) {
      const stickyElements = window.MonarkStripe.elements({ locale: prLocale() });
      mountedButtons.push({
        container: stickyContainer,
        el: stickyElements.create('paymentRequestButton', { paymentRequest, style: { paymentRequestButton: { type: PR_BUTTON_TYPE, theme: 'light', height: '43px' } } })
      });
    }

    // canMakePayment() resolves null with nothing available -- confirmed
    // live (both by direct logging and by Stripe.js itself refusing to
    // mount without it) that this is Stripe's own, correct answer, not a
    // bug on this page's end, whenever any of these hold: the page isn't
    // served over HTTPS (Stripe explicitly requires it for Apple
    // Pay/Google Pay, even in testing -- see its own console warning),
    // Apple Pay specifically pre domain-registration (disclosed elsewhere
    // in this codebase), or the browser/device genuinely has no eligible
    // wallet configured (e.g. Chrome with no Google account/saved card).
    // Both containers stay hidden and no gap is left in either row when
    // that happens; Add to Cart alone still fills the space via its own
    // flex sizing. The info log below is left in (not a temporary debug
    // line) specifically so a "why isn't this showing" question is
    // self-diagnosable from the browser console instead of a silent no-op.
    paymentRequest.canMakePayment().then((result) => {
      if (!result) {
        console.info('Payment Request Button: no eligible wallet (Apple Pay/Google Pay/Link) for this browser/page -- requires HTTPS and a configured wallet; Apple Pay additionally requires domain registration with Stripe.');
        return;
      }
      // BUG FIX: unhide BEFORE mount(), not after -- mounting into a
      // container that's still `hidden` (display:none at that instant)
      // risked Stripe measuring/initializing the iframe against a 0x0
      // layout box it never revisits once the container becomes visible a
      // tick later. Both the main content area's button and the sticky
      // bar's went through this same ordering, so this affects both, not
      // just one -- see the flex-basis fix in css/shop.css for the other,
      // width-specific half of why the main one in particular could end up
      // rendering at an unusably narrow (not necessarily zero) width even
      // once mounted.
      mountedButtons.forEach(({ container, el }) => {
        container.hidden = false;
        el.mount(container);
        // tabIndex=-1: cheap defense-in-depth, harmless even where it
        // doesn't help (confirmed live it isn't sufficient by itself in
        // Chrome). The 'focus' listener is a defensive fallback ONLY at
        // this point -- the real fix is the document-level Tab-keydown
        // interception (preventTabIntoIframe-equivalent, see
        // getPageFocusableElements()'s own keydown listener above), which
        // stops the browser from ever moving focus into the iframe in the
        // first place; this listener firing at all would mean that
        // interception somehow missed this specific path. A fresh listener
        // every time: el.mount() creates a brand new iframe node on every
        // call (langchange remounts included), so there's no
        // stale-listener-on-a-discarded-node risk to guard against here.
        const iframe = container.querySelector('iframe');
        const fallbackBtn = mountFallbackButton(container);
        if (iframe) {
          iframe.tabIndex = -1;
          iframe.addEventListener('focus', () => fallbackBtn.focus());
        }
      });
    }).catch((err) => {
      console.error('Payment Request Button: canMakePayment() failed:', err && err.message);
    });
  }
  mountButtons();

  // Elements' own locale is fixed at creation time -- a language switch
  // needs a fresh Elements group (and fresh Element instances) to pick up
  // the new one. Reuses the same paymentRequest object throughout, so this
  // never re-triggers canMakePayment() or changes what clicking either
  // button does.
  document.addEventListener('monark:langchange', mountButtons);

  // ---------------- Real payment confirmation ----------------
  // 'paymentmethod' fires once the user's already authenticated in the
  // native sheet (Face ID/Touch ID/etc.) -- a PaymentMethod exists, but
  // nothing has been charged yet, so bailing out below (missing-info path)
  // is still completely safe.
  paymentRequest.on('paymentmethod', async (ev) => {
    // Empty cart means this click itself represents "buy 1 unit" -- add it
    // now so quantity/amount below (and the order this becomes) matches
    // what the sheet just showed the payer.
    if (!cart.getCart().length) cart.addToCart(1);
    syncTotal();

    // MISSING INFO -> fall back to the full checkout flow instead of
    // completing the payment blind. The one thing this button's own flow
    // needs that checkout.html's normal flow doesn't strictly require up
    // front is an email to attach the order to (public.orders has no
    // shipping-address column at all, so that's never actually a blocker
    // either way) -- a signed-in MonarkAccount session already has one; a
    // guest wallet payment needs requestPayerEmail's own answer instead.
    // Completing the native sheet as a no-op success and redirecting is the
    // safe path here (see this handler's own opening comment on why);
    // checkout.html's account gate + prefillShippingFromAccount() already
    // pick up a signed-in session and pre-fill whatever profile data it
    // has, so nothing new is needed there for that part.
    //
    // Only a REAL logged-in account (isGuest: false) takes priority over
    // what the wallet itself just provided -- a local guest session is just
    // an email string left in localStorage from possibly unrelated earlier
    // browsing (e.g. a shared device), weaker evidence of who's actually
    // paying right now than Apple Pay/Google Pay's own payer info, so it's
    // only used as a last-resort fallback if the wallet didn't supply one.
    const rawSession = window.MonarkAccount ? window.MonarkAccount.getSession() : null;
    const loggedInSession = rawSession && !rawSession.isGuest ? rawSession : null;
    const payerEmail = (loggedInSession && loggedInSession.email)
      || ev.payerEmail
      || (ev.paymentMethod.billing_details && ev.paymentMethod.billing_details.email)
      || (rawSession && rawSession.email);
    if (!payerEmail) {
      ev.complete('success');
      window.location.href = 'checkout.html';
      return;
    }

    try {
      const items = cart.getCart();
      const quantity = items[0].quantity;
      const { data, error } = await window.MonarkSupabase.functions.invoke('create-checkout-session', {
        body: {
          quantity,
          promoCode: cart.getAppliedPromoCode() || undefined
        }
      });
      if (error || !data || !data.clientSecret) {
        console.error('create-checkout-session failed:', error || data);
        ev.complete('fail');
        return;
      }

      const { error: confirmError, paymentIntent } = await window.MonarkStripe.confirmCardPayment(
        data.clientSecret,
        { payment_method: ev.paymentMethod.id },
        { handleActions: false }
      );
      if (confirmError) {
        console.error('Payment Request Button confirmCardPayment failed:', confirmError.message);
        ev.complete('fail');
        return;
      }
      // Closes the native sheet -- must happen regardless of status below,
      // per Stripe's own documented pattern for this event.
      ev.complete('success');

      let finalIntent = paymentIntent;
      if (finalIntent.status === 'requires_action') {
        // 3D Secure or similar -- the native sheet is already closed at this
        // point (ev.complete() above), so Stripe's own redirect/challenge UI
        // (if any) takes over from here.
        const { error: actionError, paymentIntent: confirmedIntent } = await window.MonarkStripe.confirmCardPayment(data.clientSecret);
        if (actionError || !confirmedIntent) return;
        finalIntent = confirmedIntent;
      }
      if (finalIntent.status !== 'succeeded') return;

      // Payment succeeded -- record the order the same way checkout.html
      // does. Reuses the real signed-in session if there is one (so the
      // order lands in that account's own history, not stranded as a
      // separate guest row); otherwise recorded as a guest_email row under
      // whatever email the wallet provided.
      const session = loggedInSession || { email: payerEmail, isGuest: true };
      const finalTotal = cart.getFinalTotal();
      const appliedCode = cart.getAppliedPromoCode();
      await window.MonarkAccount.recordOrder(session, {
        productName: cart.PRODUCT.name,
        quantity,
        total: finalTotal,
        promoCode: appliedCode || null
      });
      cart.clearCart();
      cart.removePromoCode();
      window.location.href = 'checkout.html?expressSuccess=1&total=' + encodeURIComponent(finalTotal.toFixed(2));
    } catch (err) {
      console.error('Payment Request Button confirm failed:', err);
      ev.complete('fail');
    }
  });
})();
