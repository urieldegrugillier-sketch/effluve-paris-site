/* MONARK — accessible phone number input with a country/dial-code selector.
   Shared component (same "shared, not duplicated" reasoning as js/account.js's
   mountAccountGate()) used by BOTH the account-creation step of the shared
   account gate and checkout.html's Shipping section. Exposes
   window.MonarkPhoneInput.mount(container, options).

   Built as a lightweight, dependency-free listbox combobox, following the
   exact same accessible "custom dropdown, not a native <select>" pattern
   already established by contact.html's Reason field (trigger button +
   role="listbox" popup, arrow keys + aria-activedescendant, Enter/Space/
   Escape) -- extended here with a search input inside the popup, since a
   ~200-country list needs to be filterable to be usable at all, unlike that
   field's 4 static options. Country names are localized via the browser's
   own built-in Intl.DisplayNames (supported in every evergreen browser this
   site already targets -- same "don't hand-roll what the platform gives you
   for free" reasoning as css/checkout.css's own note on the marketing
   checkbox) rather than hand-maintaining a second FR/EN translation table
   for ~200 country names in js/i18n.js. Flag icons are rendered from Unicode
   regional-indicator symbols (computed from the ISO code, not image assets)
   -- zero-dependency, and consistent with this codebase's "no large UI
   framework, no new asset pipeline" convention -- see flagHtml() below for
   why that changed to small flag images instead. */
(function (global) {
  // [ISO 3166-1 alpha-2, E.164 country calling code (no leading '+')].
  // Deliberately NOT globally unique on the dial-code column (e.g. every
  // NANP member shares '1', Russia/Kazakhstan share '7') -- exactly like
  // every other phone-input implementation, countries are looked up/selected
  // by their ISO code, the dial code is just what's displayed alongside it.
  const COUNTRIES = [
    ['FR', '33'], ['BE', '32'], ['DE', '49'], ['GB', '44'], ['IE', '353'],
    ['ES', '34'], ['PT', '351'], ['IT', '39'], ['NL', '31'], ['LU', '352'],
    ['CH', '41'], ['AT', '43'], ['DK', '45'], ['SE', '46'], ['NO', '47'],
    ['FI', '358'], ['IS', '354'], ['PL', '48'], ['CZ', '420'], ['SK', '421'],
    ['HU', '36'], ['RO', '40'], ['BG', '359'], ['GR', '30'], ['HR', '385'],
    ['SI', '386'], ['RS', '381'], ['BA', '387'], ['ME', '382'], ['MK', '389'],
    ['AL', '355'], ['XK', '383'], ['EE', '372'], ['LV', '371'], ['LT', '370'],
    ['UA', '380'], ['BY', '375'], ['MD', '373'], ['RU', '7'], ['TR', '90'],
    ['CY', '357'], ['MT', '356'], ['AD', '376'], ['MC', '377'], ['SM', '378'],
    ['VA', '379'], ['LI', '423'],
    ['US', '1'], ['CA', '1'], ['MX', '52'], ['BR', '55'], ['AR', '54'],
    ['CL', '56'], ['CO', '57'], ['PE', '51'], ['VE', '58'], ['EC', '593'],
    ['BO', '591'], ['PY', '595'], ['UY', '598'], ['GY', '592'], ['SR', '597'],
    ['CR', '506'], ['PA', '507'], ['GT', '502'], ['HN', '504'], ['SV', '503'],
    ['NI', '505'], ['BZ', '501'], ['CU', '53'], ['DO', '1'], ['HT', '509'],
    ['JM', '1'], ['TT', '1'], ['BS', '1'], ['BB', '1'], ['GD', '1'],
    ['LC', '1'], ['VC', '1'], ['AG', '1'], ['DM', '1'], ['KN', '1'],
    ['CN', '86'], ['JP', '81'], ['KR', '82'], ['KP', '850'], ['IN', '91'],
    ['PK', '92'], ['BD', '880'], ['LK', '94'], ['NP', '977'], ['BT', '975'],
    ['MM', '95'], ['TH', '66'], ['VN', '84'], ['KH', '855'], ['LA', '856'],
    ['MY', '60'], ['SG', '65'], ['ID', '62'], ['PH', '63'], ['BN', '673'],
    ['TL', '670'], ['MN', '976'], ['KZ', '7'], ['UZ', '998'], ['TM', '993'],
    ['TJ', '992'], ['KG', '996'], ['AF', '93'], ['IR', '98'], ['IQ', '964'],
    ['SY', '963'], ['LB', '961'], ['JO', '962'], ['IL', '972'], ['PS', '970'],
    ['SA', '966'], ['YE', '967'], ['OM', '968'], ['AE', '971'], ['QA', '974'],
    ['BH', '973'], ['KW', '965'], ['GE', '995'], ['AM', '374'], ['AZ', '994'],
    ['TW', '886'], ['HK', '852'], ['MO', '853'],
    ['EG', '20'], ['LY', '218'], ['TN', '216'], ['DZ', '213'], ['MA', '212'],
    ['SD', '249'], ['SS', '211'], ['ET', '251'], ['ER', '291'], ['DJ', '253'],
    ['SO', '252'], ['KE', '254'], ['UG', '256'], ['TZ', '255'], ['RW', '250'],
    ['BI', '257'], ['NG', '234'], ['GH', '233'], ['CI', '225'], ['SN', '221'],
    ['ML', '223'], ['BF', '226'], ['NE', '227'], ['TD', '235'], ['CM', '237'],
    ['CF', '236'], ['CG', '242'], ['CD', '243'], ['GA', '241'], ['GQ', '240'],
    ['ST', '239'], ['AO', '244'], ['ZM', '260'], ['ZW', '263'], ['MW', '265'],
    ['MZ', '258'], ['NA', '264'], ['BW', '267'], ['ZA', '27'], ['SZ', '268'],
    ['LS', '266'], ['MG', '261'], ['MU', '230'], ['SC', '248'], ['KM', '269'],
    ['CV', '238'], ['GW', '245'], ['GM', '220'], ['GN', '224'], ['SL', '232'],
    ['LR', '231'], ['TG', '228'], ['BJ', '229'], ['MR', '222'],
    ['AU', '61'], ['NZ', '64'], ['FJ', '679'], ['PG', '675'], ['SB', '677'],
    ['VU', '678'], ['NC', '687'], ['PF', '689'], ['WS', '685'], ['TO', '676'],
    ['KI', '686'], ['FM', '691'], ['MH', '692'], ['PW', '680'], ['NR', '674'],
    ['TV', '688']
  ];

  const DEFAULT_COUNTRY = 'FR';
  let uid = 0;

  // CONFIRMED LIVE ISSUE: Unicode regional-indicator flag emoji (the
  // previous approach here) render as real flags on macOS/iOS/Android, but
  // as plain two-letter text ("FR", "GB"...) on a real, current Chrome/
  // Windows install with no color-flag font -- verified directly via
  // screenshot during this feature's own testing, not a hypothetical. Since
  // this is exactly the platform this site is most likely to be tested/used
  // on, emoji alone isn't reliable enough for "real flags, not text codes".
  // flagcdn.com serves tiny (~1-5KB), no-API-key, well-established SVG flag
  // icons for every ISO code -- a couple of small <img> requests per visible
  // flag, not a bundled asset pipeline, and the same "load a small external
  // resource" pattern this site already uses for Google Fonts. Falls back to
  // the bare ISO code (via the sibling .phone-country-*-flag-fallback span,
  // hidden unless the image itself fails to load) if that request ever
  // fails, so a network hiccup degrades to text instead of a broken-image icon.
  function flagHtml(iso2, cls) {
    const code = iso2.toLowerCase();
    return `<img class="${cls}" src="https://flagcdn.com/${code}.svg" alt="" width="18" height="13" loading="lazy"><span class="${cls}-fallback" hidden>${iso2}</span>`;
  }

  // Intl.DisplayNames is supported in every evergreen browser this site
  // targets (Chrome/Edge/Firefox/Safari, all for several years) -- the
  // try/catch below only guards the rare case it's missing entirely, falling
  // back to the bare ISO code so the list stays usable rather than throwing.
  const nameFormatters = {};
  function countryName(iso2, lang) {
    try {
      if (!nameFormatters[lang]) nameFormatters[lang] = new Intl.DisplayNames([lang], { type: 'region' });
      return nameFormatters[lang].of(iso2) || iso2;
    } catch (e) {
      return iso2;
    }
  }

  function lang() { return global.MonarkI18n && global.MonarkI18n.getLang() === 'fr' ? 'fr' : 'en'; }
  function t(key, vars) { return global.MonarkI18n ? global.MonarkI18n.t(key, vars) : key; }

  // Canonical storage form: digits only, no leading zero -- e.g. a French
  // local "06 12 34 56 78" becomes "612345678", stored alongside the dial
  // code ('33') and country ('FR') separately rather than as one combined
  // string, per this feature's own spec (display/store without the leading
  // 0, since the country selector already carries the "+33" half).
  function normalizeNumber(raw) {
    let digits = String(raw || '').replace(/\D/g, '');
    if (digits.charAt(0) === '0') digits = digits.slice(1);
    return digits;
  }

  function mount(container, options) {
    if (!container) return null;
    options = options || {};
    const idBase = 'phone-input-' + (++uid);

    let selectedIso = COUNTRIES.some(([iso]) => iso === (options.country || '').toUpperCase())
      ? options.country.toUpperCase()
      : DEFAULT_COUNTRY;

    container.classList.add('phone-input');

    // Flag <img> fallback (see flagHtml() above) used to be a literal
    // onerror="" HTML attribute -- moved here as a real listener so it
    // doesn't need CSP's script-src to allow inline event handlers. `error`
    // events don't bubble, so this needs capture:true on an ancestor that
    // outlives every re-render; container itself, registered once, covers
    // both the trigger's own flag and every option's flag in the country
    // list (renderList() rebuilds that <ul> from scratch on every
    // keystroke) since flagHtml() marks both with a class ending "-flag-img".
    container.addEventListener('error', (e) => {
      const img = e.target;
      if (img.tagName === 'IMG' && /-flag-img$/.test(img.className)) {
        img.hidden = true;
        if (img.nextElementSibling) img.nextElementSibling.hidden = false;
      }
    }, true);

    container.innerHTML = `
      <div class="phone-input-row">
        <button type="button" class="phone-country-trigger" id="${idBase}-trigger" aria-haspopup="listbox" aria-expanded="false" aria-label="${t('phoneInput.countrySelectorLabel')}">
          <span class="phone-country-flag" aria-hidden="true"></span>
          <span class="phone-country-dial"></span>
          <svg class="phone-country-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
            <path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <input type="tel" class="phone-number-input" id="${idBase}-number" inputmode="tel" autocomplete="tel-national" aria-label="${t('phoneInput.numberLabel')}">
      </div>
      <div class="phone-country-panel" id="${idBase}-panel" hidden>
        <input type="text" class="phone-country-search" id="${idBase}-search" role="combobox" aria-expanded="false" aria-controls="${idBase}-list" aria-autocomplete="list" aria-label="${t('phoneInput.searchLabel')}" autocomplete="off" placeholder="${t('phoneInput.searchPlaceholder')}">
        <ul class="phone-country-list" id="${idBase}-list" role="listbox" aria-label="${t('phoneInput.countrySelectorLabel')}"></ul>
      </div>
    `;

    const trigger = container.querySelector('.phone-country-trigger');
    const triggerFlag = container.querySelector('.phone-country-flag');
    const triggerDial = container.querySelector('.phone-country-dial');
    const numberInput = container.querySelector('.phone-number-input');
    const panel = container.querySelector('.phone-country-panel');
    const search = container.querySelector('.phone-country-search');
    const list = container.querySelector('.phone-country-list');

    let filtered = COUNTRIES.slice();
    let highlighted = -1;

    function sortedCountries() {
      const l = lang();
      return COUNTRIES.slice().sort((a, b) => countryName(a[0], l).localeCompare(countryName(b[0], l), l));
    }

    function renderTrigger() {
      triggerFlag.innerHTML = flagHtml(selectedIso, 'phone-country-flag-img');
      triggerDial.textContent = '+' + (COUNTRIES.find(([iso]) => iso === selectedIso) || [null, ''])[1];
      trigger.setAttribute('aria-label', t('phoneInput.countrySelectorLabel') + ': ' + countryName(selectedIso, lang()));
    }

    function renderList() {
      const l = lang();
      list.innerHTML = filtered.map(([iso, dial], i) => `
        <li role="option" id="${idBase}-opt-${i}" data-iso="${iso}" aria-selected="${iso === selectedIso}">
          <span class="phone-country-opt-flag" aria-hidden="true">${flagHtml(iso, 'phone-country-opt-flag-img')}</span>
          <span class="phone-country-opt-name">${countryName(iso, l)}</span>
          <span class="phone-country-opt-dial">+${dial}</span>
        </li>
      `).join('');
      if (!filtered.length) {
        list.innerHTML = `<li class="phone-country-no-results">${t('phoneInput.noResults')}</li>`;
      }
    }

    function updateHighlight() {
      const options = Array.from(list.querySelectorAll('li[role="option"]'));
      options.forEach((o, i) => o.classList.toggle('is-highlighted', i === highlighted));
      if (highlighted >= 0 && options[highlighted]) {
        search.setAttribute('aria-activedescendant', options[highlighted].id);
        options[highlighted].scrollIntoView({ block: 'nearest' });
      } else {
        search.removeAttribute('aria-activedescendant');
      }
    }

    function openPanel() {
      filtered = sortedCountries();
      renderList();
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      search.setAttribute('aria-expanded', 'true');
      search.value = '';
      highlighted = filtered.findIndex(([iso]) => iso === selectedIso);
      updateHighlight();
      // Deferred one frame -- same reasoning as nav-menu.js/cart-widget.js's
      // own focus-after-open calls: the panel has to actually be laid out
      // (hidden -> visible) before a browser will accept focus() on
      // something inside it. A single frame is enough here (no CSS
      // visibility-transition involved, unlike those two, which is what
      // forced their own two-frame defer).
      requestAnimationFrame(() => search.focus());
    }

    function closePanel(returnFocus) {
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      search.setAttribute('aria-expanded', 'false');
      highlighted = -1;
      if (returnFocus) trigger.focus();
    }

    function selectCountry(iso) {
      selectedIso = iso;
      renderTrigger();
      closePanel(false);
      numberInput.focus();
      if (options.onChange) options.onChange(getValue());
    }

    function filterList(query) {
      const needle = query.trim().toLowerCase();
      const all = sortedCountries();
      filtered = !needle ? all : all.filter(([iso, dial]) => {
        return countryName(iso, lang()).toLowerCase().includes(needle)
          || iso.toLowerCase().includes(needle)
          || dial.includes(needle.replace(/^\+/, ''));
      });
      renderList();
      highlighted = filtered.length ? 0 : -1;
      updateHighlight();
    }

    trigger.addEventListener('click', () => { panel.hidden ? openPanel() : closePanel(true); });
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (panel.hidden) openPanel();
      }
    });

    search.addEventListener('input', () => filterList(search.value));
    search.addEventListener('keydown', (e) => {
      const options = Array.from(list.querySelectorAll('li[role="option"]'));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (options.length) { highlighted = Math.min(highlighted + 1, options.length - 1); updateHighlight(); }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (options.length) { highlighted = Math.max(highlighted - 1, 0); updateHighlight(); }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (highlighted >= 0 && filtered[highlighted]) selectCountry(filtered[highlighted][0]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closePanel(true);
      }
      // Any other key (Tab included) is left alone -- Tab naturally moves
      // focus out of the search field to whatever's next in the DOM, which
      // reads as "closing" the panel from the user's perspective; the
      // blur/focusout handler below is what actually closes it in that case.
    });

    list.addEventListener('click', (e) => {
      const opt = e.target.closest('li[role="option"]');
      if (opt) selectCountry(opt.dataset.iso);
    });
    list.addEventListener('mousemove', (e) => {
      const opt = e.target.closest('li[role="option"]');
      if (!opt) return;
      const idx = Array.from(list.querySelectorAll('li[role="option"]')).indexOf(opt);
      if (idx !== highlighted) { highlighted = idx; updateHighlight(); }
    });

    // Closes on any focus/click leaving the whole widget -- covers Tab-out
    // from the search field, a click on the number input, and a genuine
    // outside click, without needing three separate listeners.
    document.addEventListener('focusin', (e) => {
      if (!panel.hidden && !container.contains(e.target)) closePanel(false);
    });
    document.addEventListener('click', (e) => {
      if (!panel.hidden && !container.contains(e.target)) closePanel(false);
    });
    container.addEventListener('focusout', (e) => {
      if (panel.hidden) return;
      // Moving focus from the search field to the number input (Tab) still
      // counts as "leaving the panel" -- only skip the close when the new
      // focus target is still inside the panel itself (e.g. none currently,
      // reserved for any future control added there).
      if (e.relatedTarget && panel.contains(e.relatedTarget)) return;
      closePanel(false);
    });

    numberInput.addEventListener('blur', () => {
      numberInput.value = normalizeNumber(numberInput.value);
    });
    numberInput.addEventListener('input', () => {
      if (options.onChange) options.onChange(getValue());
    });

    document.addEventListener('monark:langchange', () => {
      renderTrigger();
      trigger.setAttribute('aria-label', t('phoneInput.countrySelectorLabel') + ': ' + countryName(selectedIso, lang()));
      search.setAttribute('placeholder', t('phoneInput.searchPlaceholder'));
      search.setAttribute('aria-label', t('phoneInput.searchLabel'));
      numberInput.setAttribute('aria-label', t('phoneInput.numberLabel'));
      if (!panel.hidden) filterList(search.value);
    });

    function getValue() {
      return {
        number: normalizeNumber(numberInput.value),
        dialCode: (COUNTRIES.find(([iso]) => iso === selectedIso) || [null, ''])[1],
        country: selectedIso
      };
    }

    function setValue(value) {
      value = value || {};
      if (value.country && COUNTRIES.some(([iso]) => iso === value.country.toUpperCase())) {
        selectedIso = value.country.toUpperCase();
      }
      numberInput.value = normalizeNumber(value.number || '');
      renderTrigger();
    }

    // Field is optional everywhere it's used (account creation, checkout
    // Shipping) -- an empty number is always valid, this only judges a
    // number the user actually entered. France gets the precise standard
    // format check the task asked for (normalizeNumber() already strips a
    // single leading 0, so "9 digits" and "10 digits starting with 0" both
    // collapse to the same "9 digits after normalization" test here -- see
    // that function's own comment). Every other country gets a lenient
    // sanity range instead of hand-built per-country rules, which don't
    // generalize across ~200 countries' real numbering plans.
    function isValid() {
      const v = getValue();
      if (!v.number) return true;
      if (v.country === 'FR') return v.number.length === 9;
      return v.number.length >= 4 && v.number.length <= 14;
    }

    renderTrigger();
    if (options.number || options.country) setValue({ number: options.number, country: options.country });

    return { getValue, setValue, isValid, focus: () => numberInput.focus() };
  }

  global.MonarkPhoneInput = { mount };
})(window);
