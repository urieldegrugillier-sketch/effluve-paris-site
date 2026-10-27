/* MONARK — cookies.html page controls only (not loaded site-wide). Reads and
   displays the current consent choice, and wires Accept/Reject/Delete to the
   shared API js/cookie-consent.js exposes as window.MonarkCookieConsent, so
   this page records choices through exactly the same code path as the
   banner's own buttons. */
(function () {
  const statusEl = document.getElementById('cookie-prefs-status');
  const confirmEl = document.getElementById('cookie-prefs-confirm');
  const acceptBtn = document.getElementById('cookie-prefs-accept-btn');
  const rejectBtn = document.getElementById('cookie-prefs-reject-btn');
  const deleteBtn = document.getElementById('cookie-prefs-delete-btn');
  if (!statusEl || !acceptBtn || !rejectBtn || !deleteBtn || !window.MonarkCookieConsent) return;

  const t = window.MonarkI18n ? window.MonarkI18n.t : (key) => key;

  // null until an action is actually taken this pageview -- the confirmation
  // message starts empty (no action taken yet), and this is what the
  // langchange re-render below checks to know whether to touch it at all.
  let lastConfirmKey = null;

  function renderStatus() {
    const choice = localStorage.getItem(window.MonarkCookieConsent.STORAGE_KEY);
    statusEl.textContent = choice === 'accepted' ? t('cookiePolicy.statusAccepted')
      : choice === 'rejected' ? t('cookiePolicy.statusRejected')
      : t('cookiePolicy.statusUnset');
  }

  function showConfirm(key) {
    lastConfirmKey = key;
    confirmEl.textContent = t(key);
  }

  renderStatus();
  // Re-renders both the status line and (if one is already showing) the
  // confirmation message in the newly-selected language -- neither is
  // data-i18n-tagged markup MonarkI18n.apply() could re-walk on its own,
  // since both are plain JS-set text (same reasoning as js/cart-widget.js's
  // own render()).
  document.addEventListener('monark:langchange', () => {
    renderStatus();
    if (lastConfirmKey) confirmEl.textContent = t(lastConfirmKey);
  });

  acceptBtn.addEventListener('click', () => {
    window.MonarkCookieConsent.setChoice('accepted');
    renderStatus();
    showConfirm('cookiePolicy.confirmSaved');
  });

  rejectBtn.addEventListener('click', () => {
    window.MonarkCookieConsent.setChoice('rejected');
    renderStatus();
    showConfirm('cookiePolicy.confirmSaved');
  });

  deleteBtn.addEventListener('click', () => {
    window.MonarkCookieConsent.deleteAnalyticsAndReset();
    renderStatus();
    showConfirm('cookiePolicy.confirmDeleted');
  });
})();
