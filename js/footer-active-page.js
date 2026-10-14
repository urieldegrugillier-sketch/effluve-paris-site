/* MONARK — footer "you are here" active-page indicator. Compares the current
   page's own filename against each footer link's href and marks a match
   with the same treatment .footer-legal-links a already uses on :hover (see
   css/style.css) applied permanently, rather than the link just reading as
   plain muted text once the mouse isn't over it. Shared across every page
   that carries this footer; include via
   <script src="js/footer-active-page.js"></script>, same loading convention
   as the other small site-wide scripts (header-position-fix.js,
   cookie-consent.js, ...).

   BUG FIX (this highlight was confirmed never actually applying in
   production): used to compare location.pathname's last segment directly
   against each link's own href -- correct against a plain static file
   server (local dev), but Cloudflare serves this site with clean URLs (any
   .html-suffixed request redirects to its extension-less equivalent), so
   location.pathname's last segment in production is e.g. "faq", while
   every footer link's own href is still written as "faq.html" in this
   codebase's markup -- "faq.html" === "faq" is always false, so the match
   never fired at all, on any page, in production. normalize() strips both
   a trailing slash and any .html extension from whichever form either side
   happens to be in before comparing, so it's correct regardless of which
   URL style the current page was actually served with. Same bug,
   independently confirmed, as js/nav-cta-page-aware.js's own
   location.pathname assumption -- see that file's comment. */
(function () {
  const links = document.querySelectorAll('.footer-legal-links a[href]');
  if (!links.length) return;

  const normalize = (path) => path.replace(/\/+$/, '').split('/').pop().replace(/\.html$/, '');
  const currentPage = normalize(location.pathname);

  links.forEach((link) => {
    const linkPage = normalize(link.getAttribute('href'));
    if (linkPage === currentPage) link.classList.add('footer-link-current');
  });
})();
