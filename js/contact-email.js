// Builds the contact mailto link(s) from split data attributes rather than a
// literal address anywhere in the static HTML/i18n strings -- a crude but
// real deterrent against address-harvesting scrapers, which generally only
// read what's already in the page source, not what a same-origin script
// assembles at runtime. The <a> itself ships with no href attribute at all
// (not even "#") -- without one it's inert plain text (no pointer cursor,
// not in the tab order), which doubles as the no-JS fallback: the visible
// user/@/domain spans already in the markup still read and copy fine even
// if this script never runs. monark:langchange re-runs this because
// js/i18n.js's own apply() replaces the whole innerHTML of any
// data-i18n-html element on every language switch (see contact.reachUs/
// contact.emailNote in js/i18n.js) -- that wipes out the href this script
// set on the previous render, so it has to be set again on the fresh node.
(function () {
  function enhance(el) {
    var user = el.getAttribute('data-email-user');
    var domain = el.getAttribute('data-email-domain');
    if (!user || !domain) return;
    el.setAttribute('href', 'mailto:' + user + '@' + domain);
  }

  function enhanceAll() {
    document.querySelectorAll('.contact-email-link').forEach(enhance);
  }

  enhanceAll();
  document.addEventListener('monark:langchange', enhanceAll);
})();
