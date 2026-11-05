// Shared obfuscated-mailto helper for every ".contact-email-link" on the
// site (contact.html's reachUs line, mentions-legales.html's Contact
// section) -- the address is never written as one literal string in this
// site's HTML/i18n source, only split across data-email-user/
// data-email-domain attributes (see js/i18n.js's own contact.reachUs/
// legalNotice.contactBody). The <a> ships with no href attribute at all in
// that source -- without one it's inert plain text (no pointer cursor, not
// in the tab order), which doubles as the no-JS fallback: the visible
// user/@/domain spans already in the markup still read and copy fine even
// if this script never runs.
//
// ROOT CAUSE of the "link has no href in a real browser" bug this file now
// fixes: js/i18n.js's own apply(document) runs synchronously once, on
// initial page load, for the DEFAULT language (fr) -- entirely separately
// from its setLang()/'monark:langchange' path, which only fires on a later,
// explicit language switch. That initial pass replaces the whole innerHTML
// of every data-i18n-html element (contact.reachUs/legalNotice.contactBody
// among them), which throws away whatever this script already did to the
// English-fallback anchor that was in the raw HTML a moment earlier --
// including, critically, this script's own very first enhanceAll() call,
// which (on this page's own <script> order) runs BEFORE js/i18n.js has even
// loaded. A single 'monark:langchange' listener alone would silently miss
// this exact case, since that event never fires for the initial-load
// resolution. Listening for 'DOMContentLoaded' closes the gap: by the time
// it fires, every synchronous <script> encountered while parsing this
// document -- i18n.js included -- has already finished running its own
// top-level code, so this re-enhances the DOM i18n.js actually left behind,
// not a stale one that's about to be replaced.
//
// On top of that render-timing fix, click handling itself uses event
// delegation (one document-level listener, never attached to the anchors
// directly) specifically so it keeps working regardless of how many times
// the surrounding markup gets torn down and rebuilt -- a fresh anchor from
// a later re-render is still covered the instant it exists, no re-binding
// needed. The copy-confirmation toast below is a page-level singleton
// instead (appended once to <body>, outside any of those re-rendered
// anchors) so it survives those re-renders untouched.
(function () {
  const TOAST_DURATION = 4000;

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  // execCommand('copy') is deprecated but still the only copy path in
  // browsers/contexts without the async Clipboard API (older browsers, or
  // any non-secure-context load) -- kept purely as that fallback, never the
  // primary path.
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (err) { /* nothing more to do */ }
    document.body.removeChild(ta);
  }

  function enhance(el) {
    const user = el.getAttribute('data-email-user');
    const domain = el.getAttribute('data-email-domain');
    if (!user || !domain) return;
    el.setAttribute('href', 'mailto:' + user + '@' + domain);
  }

  function enhanceAll() {
    document.querySelectorAll('[data-email-user][data-email-domain]').forEach(enhance);
  }

  enhanceAll();
  document.addEventListener('DOMContentLoaded', enhanceAll);
  document.addEventListener('monark:langchange', enhanceAll);

  // ---------------- Copy-confirmation toast ----------------
  // One shared element, built lazily on first use (always after
  // DOMContentLoaded, since it only ever happens in response to a click) so
  // js/i18n.js has already run and its data-i18n/data-i18n-attr pass below
  // resolves real text, not a raw key.
  let toast = null;
  let emailEl = null;
  let closeBtn = null;
  let progressBar = null;
  let countdown = null;

  // Drives the progress bar and the auto-dismiss on requestAnimationFrame
  // rather than a plain setTimeout + CSS transition, specifically so pause()
  // can freeze both at the exact instant the pointer lands and resume()
  // can continue from there, instead of restarting the full 4s or having to
  // read back a live CSS transition's current computed value.
  function createCountdown(duration, onTick, onDone) {
    let remaining = duration;
    let rafId = null;
    let frameStart = null;
    function frame(ts) {
      if (frameStart === null) frameStart = ts;
      const left = remaining - (ts - frameStart);
      if (left <= 0) {
        onTick(0);
        rafId = null;
        onDone();
        return;
      }
      onTick(left / duration);
      rafId = requestAnimationFrame(frame);
    }
    return {
      start: function () {
        if (rafId !== null) return;
        frameStart = null;
        rafId = requestAnimationFrame(frame);
      },
      pause: function () {
        if (rafId === null) return;
        cancelAnimationFrame(rafId);
        if (frameStart !== null) remaining -= (performance.now() - frameStart);
        rafId = null;
        frameStart = null;
      },
      stop: function () {
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
  }

  function ensureToast() {
    if (toast) return;
    toast = document.createElement('div');
    toast.className = 'contact-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML =
      '<div class="contact-toast-icon" aria-hidden="true">' +
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 11V2.5a1 1 0 0 1 1-1H11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</div>' +
      '<div class="contact-toast-body">' +
        '<span class="contact-toast-title" data-i18n="common.emailCopied"></span>' +
        '<span class="contact-toast-email"></span>' +
      '</div>' +
      '<button type="button" class="contact-toast-close" data-i18n-attr="aria-label:common.toastClose">' +
        '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1.2 1.2L9.8 9.8M9.8 1.2L1.2 9.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
      '</button>' +
      '<div class="contact-toast-progress"><div class="contact-toast-progress-bar"></div></div>';
    document.body.appendChild(toast);
    if (window.MonarkI18n) window.MonarkI18n.apply(toast);

    emailEl = toast.querySelector('.contact-toast-email');
    closeBtn = toast.querySelector('.contact-toast-close');
    progressBar = toast.querySelector('.contact-toast-progress-bar');

    closeBtn.addEventListener('click', hideToast);
    toast.addEventListener('mouseenter', function () { if (countdown) countdown.pause(); });
    toast.addEventListener('mouseleave', function () { if (countdown) countdown.start(); });
    toast.addEventListener('touchstart', function () { if (countdown) countdown.pause(); }, { passive: true });
    toast.addEventListener('touchend', function () { if (countdown) countdown.start(); }, { passive: true });
    toast.addEventListener('touchcancel', function () { if (countdown) countdown.start(); }, { passive: true });
  }

  // Clears any inline override from a previous call before checking again --
  // on every other page this toast exists on, --cookie-banner-h (set in
  // css/style.css's :root) already covers the cookie banner on its own, so
  // the CSS default bottom offset applies and this only needs to act when a
  // product-page-style floating buy bar is actually on screen above it.
  function updateBottomOffset() {
    const bar = document.querySelector('.shop-sticky-bar.shop-sticky-bar-visible, .shop-desktop-bar.shop-desktop-bar-visible');
    if (!bar) {
      toast.style.removeProperty('bottom');
      return;
    }
    const clearance = Math.max(0, window.innerHeight - bar.getBoundingClientRect().top) + 20;
    toast.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + ' + clearance + 'px)';
  }

  function hideToast() {
    if (countdown) { countdown.stop(); countdown = null; }
    if (toast) toast.classList.remove('is-visible');
  }

  function showToast(address) {
    ensureToast();
    emailEl.textContent = address;
    updateBottomOffset();
    if (countdown) countdown.stop();
    progressBar.style.transform = 'scaleX(1)';
    countdown = createCountdown(TOAST_DURATION, function (frac) {
      progressBar.style.transform = 'scaleX(' + frac + ')';
    }, hideToast);
    toast.classList.add('is-visible');
    countdown.start();
  }

  // Single delegated listener, not one per anchor -- see this file's own
  // top comment for why that's what actually makes clicking survive any
  // number of re-renders. preventDefault() only stops the plain left-click
  // navigation this handler replaces with its own copy-then-navigate
  // sequence; middle-click/right-click/hover-preview-in-the-status-bar all
  // read the real href attribute directly and are untouched by this.
  document.addEventListener('click', function (e) {
    const target = e.target.closest('[data-email-user][data-email-domain]');
    if (!target) return;
    const user = target.getAttribute('data-email-user');
    const domain = target.getAttribute('data-email-domain');
    if (!user || !domain) return;
    e.preventDefault();
    const address = user + '@' + domain;
    copyText(address);
    showToast(address);
    // mailto: doesn't unload this page (it just hands off to the OS/mail
    // client), so the toast above stays visible for its own full 4s
    // regardless of this running right away rather than after a delay.
    window.location.href = 'mailto:' + address;
  });
})();
