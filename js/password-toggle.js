/* MONARK — show/hide toggle for <input type="password"> fields, shared
   site-wide (login, create-account, and the recovery form in js/account.js's
   mountAccountGate(); account.html's own Edit Profile password field via
   js/account-page.js). Exposes window.MonarkPasswordToggle.mount(inputEl).

   Unlike js/phone-input.js's own mount(container, options) -- which builds
   everything inside an initially-empty container -- every password field
   here already exists as real markup, so this wraps the EXISTING input in
   place: a position:relative <div class="password-toggle-wrap"> takes the
   input's spot in the DOM, the input moves inside it, and a toggle button
   (absolutely positioned by css/checkout.css) is appended alongside it.

   Single SVG per button (eye outline + a slash <path> shown/hidden via CSS
   on aria-pressed, not two swapped icons) -- same "one persistent element,
   state driven by a class/attribute" preference as js/nav-menu.js's own
   hamburger-to-close icon, for the same reason: avoids any re-render/layout
   flicker on every click. */
(function (global) {
  function t(key) { return global.MonarkI18n ? global.MonarkI18n.t(key) : key; }

  const ICON_HTML = `
    <svg class="password-toggle-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M1.5 9C1.5 9 4.5 3.8 9 3.8C13.5 3.8 16.5 9 16.5 9C16.5 9 13.5 14.2 9 14.2C4.5 14.2 1.5 9 1.5 9Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="9" cy="9" r="2.3" stroke="currentColor" stroke-width="1.3"/>
      <path class="password-toggle-slash" d="M2.5 2.5L15.5 15.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>
  `;

  // Idempotent -- mountAccountGate() builds its markup (and calls this) only
  // once per real input, but this guards against a second accidental call on
  // the same element rather than assuming callers always get that right.
  function mount(inputEl) {
    if (!inputEl || inputEl.dataset.passwordToggleMounted) return;
    inputEl.dataset.passwordToggleMounted = '1';

    const wrap = document.createElement('div');
    wrap.className = 'password-toggle-wrap';
    inputEl.parentNode.insertBefore(wrap, inputEl);
    wrap.appendChild(inputEl);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'password-toggle-btn';
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = ICON_HTML;
    wrap.appendChild(btn);

    function updateLabel() {
      const visible = inputEl.type === 'text';
      btn.setAttribute('aria-label', visible ? t('common.hidePassword') : t('common.showPassword'));
    }
    updateLabel();

    btn.addEventListener('click', () => {
      const visible = inputEl.type === 'text';
      inputEl.type = visible ? 'password' : 'text';
      btn.setAttribute('aria-pressed', String(!visible));
      updateLabel();
    });
    // Same event js/checkout-page.js's own summary re-render listens for --
    // keeps the label's language current without re-running mount() itself.
    document.addEventListener('monark:langchange', updateLabel);
  }

  global.MonarkPasswordToggle = { mount };
})(window);
