/* MONARK — footer "you are here" active-page indicator. Compares the current
   page's own filename against each footer link's href and marks a match
   with the same treatment .footer-legal-links a already uses on :hover (see
   css/style.css) applied permanently, rather than the link just reading as
   plain muted text once the mouse isn't over it. Shared across every page
   that carries this footer; include via
   <script src="js/footer-active-page.js"></script>, same loading convention
   as the other small site-wide scripts (header-position-fix.js,
   cookie-consent.js, ...). */
(function () {
  const links = document.querySelectorAll('.footer-legal-links a[href]');
  if (!links.length) return;

  // location.pathname's last segment -- e.g. ".../faq.html" -> "faq.html".
  // Every page on this site is always requested by its own explicit filename
  // (see README's local-dev instructions, and every internal link site-wide
  // points at one directly) -- there's no bare-directory/trailing-slash URL
  // in real use here to also account for.
  const currentPage = location.pathname.split('/').pop();

  links.forEach((link) => {
    const linkPage = link.getAttribute('href').split('/').pop();
    if (linkPage === currentPage) link.classList.add('footer-link-current');
  });
})();
