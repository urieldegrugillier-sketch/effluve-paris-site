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
// needed.
(function () {
  function t(key) { return window.MonarkI18n ? window.MonarkI18n.t(key) : key; }

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

  // Wraps the anchor in a position:relative span (if not already) and adds
  // the hidden "Address copied" badge as its sibling -- position:absolute on
  // the badge itself (see css/style.css) is what keeps this from ever
  // shifting surrounding text when it appears, so this wrap only needs to
  // exist, not carry any layout weight of its own. Re-run on every
  // enhanceAll() pass (including right before showing the badge on click)
  // since a data-i18n-html re-render tears down and rebuilds the anchor's
  // whole parent, taking any previous wrap/badge with it.
  function ensureWrap(anchor) {
    let wrap = anchor.parentElement;
    if (!wrap || !wrap.classList.contains('contact-email-wrap')) {
      wrap = document.createElement('span');
      wrap.className = 'contact-email-wrap';
      anchor.parentNode.insertBefore(wrap, anchor);
      wrap.appendChild(anchor);
    }
    let badge = wrap.querySelector('.contact-email-copied');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'contact-email-copied';
      badge.setAttribute('aria-live', 'polite');
      badge.hidden = true;
      wrap.appendChild(badge);
    }
    badge.textContent = t('common.emailCopied');
    return { wrap, badge };
  }

  function enhance(el) {
    const user = el.getAttribute('data-email-user');
    const domain = el.getAttribute('data-email-domain');
    if (!user || !domain) return;
    el.setAttribute('href', 'mailto:' + user + '@' + domain);
    ensureWrap(el);
  }

  function enhanceAll() {
    document.querySelectorAll('[data-email-user][data-email-domain]').forEach(enhance);
  }

  enhanceAll();
  document.addEventListener('DOMContentLoaded', enhanceAll);
  document.addEventListener('monark:langchange', enhanceAll);

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
    const { badge } = ensureWrap(target);
    badge.textContent = t('common.emailCopied');
    badge.hidden = false;
    if (badge._hideTimer) clearTimeout(badge._hideTimer);
    badge._hideTimer = setTimeout(function () { badge.hidden = true; }, 2000);
    // mailto: doesn't unload this page (it just hands off to the OS/mail
    // client), so the badge above stays visible for its own full 2s
    // regardless of this running right away rather than after a delay.
    window.location.href = 'mailto:' + address;
  });
})();
