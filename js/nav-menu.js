/* MONARK — site-wide header hamburger nav menu: one left-side panel, sized
   to fit its own content, plus a dimmed backdrop over the rest of the page,
   same treatment at every breakpoint (previously desktop-only, with
   mobile/tablet swapping to a full-viewport overlay below ~1024px -- that
   full-screen mode is gone, see css/style.css's .nav-menu comment for how
   the panel is sized now).
   Injects its own markup so it doesn't need to be duplicated in every page's
   header HTML -- same pattern cart-widget.js already uses. Replaces the old
   "Acquire" CTA link, which index.html was the only page to actually have.

   Both the panel and its backdrop sit BEHIND .site-header in z-index (see
   css/style.css) -- unlike every other overlay on this site (cart preview,
   email popup, cookie banner all sit above the header). .site-header itself
   (logo, this menu's own hamburger/X, cart icon) stays visible and usable
   the entire time the menu is open, which is what lets the close control
   just be the hamburger button morphing into an X in place (see
   .nav-hamburger-active) instead of a separate element that has to be kept
   in sync with it. */
(function () {
  const nav = document.querySelector('.site-nav');
  if (!nav) return;

  const hamburger = document.createElement('button');
  hamburger.type = 'button';
  hamburger.className = 'nav-hamburger';
  hamburger.id = 'nav-hamburger';
  hamburger.setAttribute('aria-label', window.MonarkI18n ? window.MonarkI18n.t('navMenu.openMenu') : 'Open menu');
  hamburger.setAttribute('aria-expanded', 'false');
  hamburger.setAttribute('aria-controls', 'nav-menu');
  // Single inline SVG, three <rect> bars -- NOT three separately-positioned
  // DOM elements (see css/style.css's .nav-hamburger-icon comment for why:
  // three independent elements measured pixel-identical yet still rendered
  // visibly uneven, because each one lands at its own fractional
  // device-pixel phase depending on the display's scale factor; one SVG
  // draws all three bars in a single shared rendering/scaling context so
  // that can't happen). 20x13 viewBox: three 20x1 bars at y=0/6/12, same
  // geometry (20px wide, 1px tall, 6px center-to-center) the old markup had.
  hamburger.innerHTML = `
    <svg class="nav-hamburger-icon" width="20" height="13" viewBox="0 0 20 13" aria-hidden="true">
      <rect class="nav-hamburger-line" x="0" y="0" width="20" height="1"></rect>
      <rect class="nav-hamburger-line" x="0" y="6" width="20" height="1"></rect>
      <rect class="nav-hamburger-line" x="0" y="12" width="20" height="1"></rect>
    </svg>
  `;
  // Inserted as .site-nav's first child (before .nav-logo/.nav-links) --
  // .nav-logo is position:absolute (out of the flex flow entirely, see its
  // own CSS comment), so the only two real flex items are this button and
  // .nav-links; margin-right:auto on the button (see css/style.css) is what
  // actually pins it to the left while .nav-links stays packed at the right
  // via .site-nav's own justify-content:flex-end, regardless of DOM order --
  // but leading with it in the markup keeps tab order matching the visual
  // left-to-right layout.
  nav.insertBefore(hamburger, nav.firstChild);

  // Sibling of .nav-menu, not a descendant -- clicking it needs to read as an
  // "outside click" to the document-level listener further down (which
  // checks menu.contains(e.target)), so it can't live inside .nav-menu
  // itself. Visible at every breakpoint: the panel never covers the full
  // viewport (see css/style.css's .nav-menu width), so there's always a
  // dimmed sliver of the real page showing behind it to click.
  const backdrop = document.createElement('div');
  backdrop.className = 'nav-menu-backdrop';
  document.body.appendChild(backdrop);

  // Each entry is wrapped in .nav-menu-item so css/style.css can put a
  // full-width divider under it (border-bottom on the wrapper, not the link
  // itself, so Monark's thumbnail and Info's chevron sit inside the same
  // bordered row rather than the divider only running under the text).
  // Only "Monark" gets a thumbnail -- Homepage/Checkout/Info/Account aren't
  // product entries, so forcing a photo onto them wouldn't mean anything;
  // Monark is the only one that reasonably has one.
  const menu = document.createElement('div');
  menu.className = 'nav-menu';
  menu.id = 'nav-menu';
  // Modal for keyboard/assistive tech while open: role+aria-modal is the
  // announcement half (see openMenu()/trapTab() below for the actual
  // enforcement -- aria-modal alone doesn't trap anything by itself, it's
  // just the hint some screen readers use to treat the page behind it as
  // inert). aria-label matches the inner <nav>'s own name below -- a dialog
  // needs an accessible name of its own, not just a landmark nested inside it.
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-modal', 'true');
  menu.setAttribute('aria-label', 'Site menu');
  menu.setAttribute('data-i18n-attr', 'aria-label:navMenu.siteMenu');
  menu.innerHTML = `
    <nav class="nav-menu-links" aria-label="Site menu" data-i18n-attr="aria-label:navMenu.siteMenu">
      <div class="nav-menu-item nav-menu-item-lang">
        <div class="nav-menu-lang-toggle" role="group" aria-label="Language">
          <button type="button" class="nav-menu-lang-btn" data-lang="fr">FR</button>
          <span class="nav-menu-lang-sep" aria-hidden="true">/</span>
          <button type="button" class="nav-menu-lang-btn" data-lang="en">EN</button>
        </div>
      </div>
      <div class="nav-menu-item">
        <a href="index.html" class="nav-menu-link" data-i18n="navMenu.homepage">Homepage</a>
      </div>
      <div class="nav-menu-item">
        <a href="product.html" class="nav-menu-link nav-menu-product-link">
          <span>Monark</span>
          <img src="assets/images/F01_V4_OnlineRef.webp" alt="" class="nav-menu-product-thumb" width="1024" height="1024" loading="lazy">
        </a>
      </div>
      <div class="nav-menu-item">
        <a href="checkout.html" class="nav-menu-link" data-i18n="navMenu.checkout">Checkout</a>
      </div>
      <div class="nav-menu-item">
        <button type="button" class="nav-menu-link nav-menu-info-toggle" aria-expanded="false" aria-controls="nav-menu-info-sublist">
          <span data-i18n="navMenu.info">Info</span>
          <svg class="nav-menu-info-chevron" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M3.5 5.25L7 8.75L10.5 5.25" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <div class="nav-menu-sublist" id="nav-menu-info-sublist">
          <a href="faq.html" class="nav-menu-sublink" data-i18n="navMenu.faq">FAQ</a>
          <a href="contact.html" class="nav-menu-sublink" data-i18n="navMenu.contact">Contact</a>
          <a href="mentions-legales.html" class="nav-menu-sublink" data-i18n="navMenu.legalNotice">Legal Notice</a>
          <a href="cgv.html" class="nav-menu-sublink" data-i18n="navMenu.termsOfSale">Terms of Sale</a>
          <a href="confidentialite.html" class="nav-menu-sublink" data-i18n="navMenu.privacyPolicy">Privacy Policy</a>
        </div>
      </div>
      <div class="nav-menu-item">
        <a href="account.html" class="nav-menu-link" data-i18n="navMenu.account">Account</a>
      </div>
    </nav>
  `;
  document.body.appendChild(menu);

  // Language toggle: small, secondary-weight pair of buttons below Account --
  // styled off .nav-menu-sublink (see css/style.css) rather than the bold
  // main .nav-menu-link treatment, so it reads as a utility control, not a
  // seventh nav destination. Swaps the page's language in place (MonarkI18n.
  // setLang() re-walks every data-i18n element and fires 'monark:langchange'
  // for the other injected-markup scripts to pick up) -- no page reload.
  if (window.MonarkI18n) {
    const langButtons = menu.querySelectorAll('.nav-menu-lang-btn');
    function syncLangButtons() {
      const current = window.MonarkI18n.getLang();
      langButtons.forEach((btn) => {
        btn.classList.toggle('nav-menu-lang-btn-active', btn.dataset.lang === current);
        btn.setAttribute('aria-pressed', String(btn.dataset.lang === current));
      });
    }
    langButtons.forEach((btn) => {
      btn.addEventListener('click', () => window.MonarkI18n.setLang(btn.dataset.lang));
    });
    syncLangButtons();
    document.addEventListener('monark:langchange', () => {
      syncLangButtons();
      // Keep the hamburger's own aria-label in sync too if the user switches
      // language while the menu is open/closed -- it lives outside .nav-menu
      // (see the comment above hamburger's creation), so MonarkI18n.apply()
      // on the menu container above never reaches it.
      const isOpen = menu.classList.contains('nav-menu-open');
      hamburger.setAttribute('aria-label', window.MonarkI18n.t(isOpen ? 'navMenu.closeMenu' : 'navMenu.openMenu'));
    });
    window.MonarkI18n.apply(menu);
  }

  // Info expands its own sublist in place -- no navigation, doesn't close
  // the rest of the menu. Only one accordion exists in this list, so a plain
  // toggle (no "close the other one first" bookkeeping) is all that's
  // needed; see resetInfoAccordion() below for why it still resets on close.
  const infoToggle = menu.querySelector('.nav-menu-info-toggle');
  const infoSublist = menu.querySelector('.nav-menu-sublist');

  function toggleInfoAccordion() {
    const isOpen = infoToggle.getAttribute('aria-expanded') === 'true';
    infoToggle.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    infoSublist.classList.toggle('nav-menu-sublist-open', !isOpen);
  }

  // Collapses Info back to closed without animating -- called whenever the
  // whole menu closes, so reopening it later (mobile drawer or desktop
  // panel) always starts from the same clean state instead of remembering
  // whatever the user left it in last time.
  function resetInfoAccordion() {
    infoToggle.setAttribute('aria-expanded', 'false');
    infoSublist.classList.remove('nav-menu-sublist-open');
  }

  infoToggle.addEventListener('click', toggleInfoAccordion);

  // Width is CSS fit-content now (see css/style.css's .nav-menu comment) --
  // not a viewport-relative metric, so there's no window.innerWidth jitter
  // for it to inherit and nothing for JS to compute there anymore. Height
  // still is: document.documentElement.clientHeight, not vh/dvh, the same
  // fixed-metric approach already used for .site-header/.canvas-wrap/
  // #dark-overlay elsewhere in this codebase (see their own comments) --
  // the panel is still visible while the page behind its backdrop can be
  // scrolled (scroll is never locked, see openMenu() below), so the same
  // care against jitter still applies to the one dimension that's still
  // viewport-relative.
  function sizeMenuHeight() {
    menu.style.height = document.documentElement.clientHeight + 'px';
  }

  // Modal focus trap. The hamburger/close toggle is part of the cycle (see
  // the task's own list: "close/hamburger toggle, Homepage, Monark,
  // Checkout, Info toggle + its sublinks when expanded, Account") but it
  // lives in .site-header, not inside .nav-menu itself -- the two are far
  // apart in DOM order (hamburger near the top of <body>, .nav-menu
  // appended at the very end, see the comment above document.body.appendChild(menu)
  // further up). That means a lighter-touch trap that only intercepts Tab at
  // the first/last element (like js/email-popup.js's, whose whole popup is
  // one contiguous DOM subtree) isn't enough here: forward-Tab from the
  // hamburger would fall through to native DOM order -- .nav-logo, then the
  // rest of the page -- long before ever reaching .nav-menu's own links.
  // Every Tab press is intercepted instead, and focus is moved explicitly to
  // the next/previous item in this array, so the cycle never depends on
  // where things actually sit in the document.
  function getFocusableMenuElements() {
    const items = [hamburger, ...menu.querySelectorAll('button, a[href]')];
    return items.filter((el) => {
      if (el.offsetParent === null) return false;
      // offsetParent alone doesn't catch this: the Info sublist's links stay
      // in normal flow (just clipped via max-height:0/overflow:hidden) when
      // collapsed, see .nav-menu-sublist, so they'd otherwise still measure
      // as "visible" and end up reachable via Tab while invisible.
      const sublist = el.closest('.nav-menu-sublist');
      return !sublist || sublist.classList.contains('nav-menu-sublist-open');
    });
  }

  function trapTab(e) {
    if (e.key !== 'Tab') return;
    const focusable = getFocusableMenuElements();
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

  function openMenu() {
    sizeMenuHeight();
    menu.classList.add('nav-menu-open');
    backdrop.classList.add('nav-menu-open');
    hamburger.classList.add('nav-hamburger-active');
    hamburger.setAttribute('aria-expanded', 'true');
    hamburger.setAttribute('aria-label', window.MonarkI18n ? window.MonarkI18n.t('navMenu.closeMenu') : 'Close menu');
    // Standard dialog-open behavior (ARIA APG): move focus into the panel's
    // first focusable item rather than leaving it sitting on the trigger --
    // the hamburger/close toggle is still just a Shift+Tab away (it's first
    // in trapTab's own cycle).
    //
    // Deferred two frames on purpose -- confirmed via direct instrumentation
    // (logging every focus() call plus getComputedStyle(menu).visibility at
    // the moment it fires) that calling this synchronously, or even after
    // just one requestAnimationFrame, right after classList.add() above,
    // silently fails: .nav-menu's visibility:hidden->visible flip is driven
    // by its own CSS transition (see that rule's `transition:
    // ...visibility 0.5s`), and a transition triggered by a class change
    // doesn't actually start until the frame *after* the one where the
    // style recalc first picks up the new class -- checked directly,
    // visibility still read "hidden" after one rAF and only flipped to
    // "visible" after two. Browsers refuse to focus an element they still
    // consider hidden, so the single-rAF version silently left focus on the
    // hamburger. Two rAFs is the standard fix for this exact class change ->
    // transition-start race.
    const firstLink = menu.querySelector('.nav-menu-link');
    if (firstLink) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => firstLink.focus());
      });
    }
  }

  function closeMenu() {
    menu.classList.remove('nav-menu-open');
    backdrop.classList.remove('nav-menu-open');
    hamburger.classList.remove('nav-hamburger-active');
    hamburger.setAttribute('aria-expanded', 'false');
    hamburger.setAttribute('aria-label', window.MonarkI18n ? window.MonarkI18n.t('navMenu.openMenu') : 'Open menu');
    resetInfoAccordion();
    // Standard dialog-close behavior (ARIA APG): return focus to whatever
    // opened it. Covers the X/toggle click, Escape, and backdrop-click paths
    // -- all three call this same function. A link inside the menu
    // navigating away never calls closeMenu() at all (the browser is
    // already unloading the page), so that path is excluded without needing
    // a special case here.
    hamburger.focus();
  }

  hamburger.addEventListener('click', (e) => {
    // Stops this same click from reaching the document-level outside-click
    // listener below in the same tick -- otherwise a click that OPENS the
    // menu would immediately read as "menu open, click landed outside it"
    // and close what it just opened, before it was ever visible. Same
    // regression (and same fix) js/cart-widget.js's preview toggle hit.
    e.stopPropagation();
    if (menu.classList.contains('nav-menu-open')) closeMenu();
    else openMenu();
  });

  // .site-header itself (logo, hamburger, cart icon) sits above both the
  // panel and its backdrop in z-index at every breakpoint (see
  // css/style.css) and stays visible/clickable the whole time the menu is
  // open, so a click landing on that header's own empty space -- not the
  // hamburger, not the logo, not the cart icon -- is a real outside click
  // worth honoring, same as a click anywhere on .nav-menu-backdrop (a
  // sibling of .nav-menu, so not `.contains()`-ed by it either).
  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('nav-menu-open')) return;
    if (menu.contains(e.target) || hamburger.contains(e.target)) return;
    closeMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (!menu.classList.contains('nav-menu-open')) return;
    if (e.key === 'Escape') { closeMenu(); return; }
    trapTab(e);
  });

  window.addEventListener('resize', () => {
    if (menu.classList.contains('nav-menu-open')) sizeMenuHeight();
  });
})();
