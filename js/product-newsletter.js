(function () {
  // Wires this page's own newsletter form to the shared submission logic
  // js/email-popup.js exposes as window.MonarkEmailCapture (validate/
  // capture/confirmedTexts) -- same validation, same real
  // newsletter_subscribers capture (source: 'newsletter_section', vs. the
  // popup's own 'popup'), same confirmation copy, no separate implementation.
  const form = document.getElementById('shop-newsletter-form');
  const inner = document.getElementById('shop-newsletter-inner');
  if (!form || !inner || !window.MonarkEmailCapture) return;

  const input = document.getElementById('shop-newsletter-input');
  const honeypot = document.getElementById('shop-newsletter-honeypot');
  const errorEl = document.getElementById('shop-newsletter-error');
  let confirmedLangListener = null;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = input.value.trim();
    const result = window.MonarkEmailCapture.validateEmail(email);
    if (!result.ok) {
      errorEl.textContent = window.MonarkI18n ? window.MonarkI18n.t('emailPopup.' + result.errorKey) : 'Please enter a valid email address.';
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;
    // honeypot non-empty -- see .email-popup-honeypot's own CSS comment
    // (css/style.css) -- still shows the normal confirmation below, just
    // skips the real insert (captureEmail's own honeypotValue check).
    window.MonarkEmailCapture.captureEmail(email, 'newsletter_section', honeypot.value);

    // Same renderConfirmed-on-language-change pattern as js/email-popup.js's
    // own confirmation state, for the same reason: a language switch (nav
    // menu FR/EN toggle) while this is showing needs to redraw it, and the
    // promo code/email vars mean this can't just be plain data-i18n tags
    // re-walked by MonarkI18n.apply() like the rest of the page.
    function renderConfirmed() {
      const { kicker, heading, copyHtml, newsletterNote } = window.MonarkEmailCapture.confirmedTexts();
      // .shop-newsletter-confirmed (css/shop.css) drops the two-column desktop
      // grid back to a single centered block -- flat confirmation copy has no
      // second column to sit in.
      inner.classList.add('shop-newsletter-confirmed');
      inner.innerHTML = `
        <span class="section-label shop-newsletter-kicker">${kicker}</span>
        <h2 class="email-popup-heading">${heading}</h2>
        <p class="email-popup-copy">${copyHtml}</p>
        <p class="email-popup-consent">${newsletterNote}</p>
      `;
      inner.querySelector('.email-popup-confirmed-email').textContent = email;
    }
    renderConfirmed();
    if (confirmedLangListener) document.removeEventListener('monark:langchange', confirmedLangListener);
    confirmedLangListener = renderConfirmed;
    document.addEventListener('monark:langchange', confirmedLangListener);
  });
})();
