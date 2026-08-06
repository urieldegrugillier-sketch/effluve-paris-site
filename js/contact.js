(function () {
  function t(key, vars) { return window.MonarkI18n ? window.MonarkI18n.t(key, vars) : key; }

  const form = document.getElementById('contact-form');
  const message = document.getElementById('contact-form-message');
  if (!form || !message) return;

  /* ---------------- Custom "Reason" dropdown ----------------
     See the HTML comment above .custom-select for why this isn't a native
     <select>. Keyboard/ARIA follows the standard "select mimic" listbox
     pattern: focus stays on the trigger button the whole time (never moves
     into the <ul>), arrow keys move a highlighted option + aria-activedescendant,
     Enter/Space/click selects, Escape closes without changing the selection. */
  const trigger = document.getElementById('reason-trigger');
  const triggerText = document.getElementById('reason-trigger-text');
  const list = document.getElementById('reason-list');
  const reasonValue = document.getElementById('reason-value');
  const reasonError = document.getElementById('reason-error');
  const options = Array.from(list.querySelectorAll('li'));
  let highlighted = -1;

  function updateHighlight() {
    options.forEach((o, i) => o.classList.toggle('is-highlighted', i === highlighted));
    if (highlighted >= 0) trigger.setAttribute('aria-activedescendant', options[highlighted].id);
  }

  function openList() {
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const selectedIdx = options.findIndex((o) => o.getAttribute('aria-selected') === 'true');
    highlighted = selectedIdx >= 0 ? selectedIdx : 0;
    updateHighlight();
  }

  function closeList() {
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    highlighted = -1;
  }

  function selectOption(index) {
    const opt = options[index];
    options.forEach((o) => o.setAttribute('aria-selected', 'false'));
    opt.setAttribute('aria-selected', 'true');
    // opt.textContent is already correctly translated (the <li> options carry
    // their own data-i18n tags, kept in sync by MonarkI18n.apply()) -- but
    // copying it into triggerText loses that live link, since triggerText
    // itself no longer reflects any single data-i18n key once a real value is
    // selected (it's a snapshot of whichever option was picked, not a fixed
    // string). removeAttribute drops triggerText's own placeholder tag so a
    // later language switch's global apply() doesn't stomp this snapshot back
    // to "Select one" -- the monark:langchange listener below re-syncs it
    // from the (by-then-retranslated) selected option instead.
    triggerText.removeAttribute('data-i18n');
    triggerText.textContent = opt.textContent;
    trigger.removeAttribute('data-placeholder');
    reasonValue.value = opt.dataset.value;
    reasonError.hidden = true;
    closeList();
    trigger.focus();
  }

  // Re-syncs the trigger's displayed text from the currently selected option
  // once MonarkI18n.apply(document) has already retranslated every <li> --
  // only relevant once a real selection has been made (see selectOption()
  // above); before that, triggerText still carries its own data-i18n tag and
  // apply() keeps it correct on its own.
  document.addEventListener('monark:langchange', () => {
    if (!reasonValue.value) return;
    const opt = options.find((o) => o.dataset.value === reasonValue.value);
    if (opt) triggerText.textContent = opt.textContent;
  });

  trigger.addEventListener('click', () => { list.hidden ? openList() : closeList(); });

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.hidden) { openList(); } else { highlighted = Math.min(highlighted + 1, options.length - 1); updateHighlight(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) { openList(); } else { highlighted = Math.max(highlighted - 1, 0); updateHighlight(); }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (list.hidden) { openList(); } else if (highlighted >= 0) { selectOption(highlighted); }
    } else if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault();
      closeList();
    }
  });

  options.forEach((opt, i) => {
    opt.addEventListener('click', () => selectOption(i));
    opt.addEventListener('mouseenter', () => { highlighted = i; updateHighlight(); });
  });

  document.addEventListener('click', (e) => {
    if (!list.hidden && !trigger.contains(e.target) && !list.contains(e.target)) closeList();
  });

  /* ---------------- Message character counter ---------------- */
  const messageField = document.getElementById('contact-message');
  const counter = document.getElementById('contact-char-counter');
  const MAX_MESSAGE_LENGTH = messageField.maxLength;
  function updateCounter() { counter.textContent = `${messageField.value.length} / ${MAX_MESSAGE_LENGTH}`; }
  messageField.addEventListener('input', updateCounter);

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    // Honeypot check -- see the comment on .contact-honeypot above.
    const honeypot = form.querySelector('[name="company_website"]');
    if (honeypot && honeypot.value) return;

    // The custom dropdown has no native constraint validation to lean on
    // (hidden inputs are excluded from it entirely) -- check it by hand.
    if (!reasonValue.value) {
      reasonError.hidden = false;
      trigger.focus();
      return;
    }

    // The <input type="email"> above only gets real constraint validation
    // from the browser if the form ISN'T novalidate (it is, see the comment
    // on why this handler starts with e.preventDefault()) -- so this is the
    // only email check that actually runs. Reuses the same canonical format
    // check as every other email field on the site (js/email-popup.js's
    // window.MonarkValidateEmail; see that file's own comment) and the same
    // generic "enter your email"/"enter a valid email" copy the popup
    // already uses, rather than inventing separate wording for this form.
    const emailInput = form.querySelector('[name="email"]');
    const emailError = document.getElementById('contact-email-error');
    const email = emailInput.value.trim();
    if (!email) {
      emailError.textContent = t('emailPopup.errorEmpty');
      emailError.hidden = false;
      emailInput.focus();
      return;
    }
    if (!window.MonarkValidateEmail || !window.MonarkValidateEmail(email)) {
      emailError.textContent = t('emailPopup.errorInvalid');
      emailError.hidden = false;
      emailInput.focus();
      return;
    }
    emailError.hidden = true;

    // Mock success only -- no backend or form-handling service (e.g.
    // Formspree) is wired up yet. Wire one of those up before launch; this
    // just simulates the round-trip so the UI can be built/tested now.
    // message's own text comes from its data-i18n="contact.successMessage"
    // tag in the HTML (a single fixed string, unlike the dropdown above) --
    // MonarkI18n keeps it correct on its own, including across a later
    // language switch, so this only ever needs to toggle visibility.
    form.hidden = true;
    message.hidden = false;
  });
})();
