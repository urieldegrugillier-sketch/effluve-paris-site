/* MONARK — Google Places Autocomplete on the "Address" field (checkout.html's
   Shipping section, account.html's Saved Address form). Shared across both
   pages: it just enhances every `input[name="address"]` it finds, so neither
   page needs its own copy of this logic.

   Built on Places API (New)'s Autocomplete Data API
   (google.maps.places.AutocompleteSuggestion), not the old
   google.maps.places.Autocomplete class -- that legacy class is unavailable
   to any Cloud project created after March 1 2025 and is being retired for
   older ones too. It's also not built on the newer PlaceAutocompleteElement
   widget: that widget renders its own shadow-DOM <input>, and this site's
   Address field needs to stay the exact same real, plain `input[name="address"]`
   it always was -- account.html's saved-address prefill and checkout.html's
   account-prefill/validation/Next-Step-button logic all read and WRITE that
   element's .value directly, which a shadow-DOM replacement can't
   transparently support. Rebuilding just the suggestions dropdown by hand
   over the real input keeps every one of those call sites untouched.

   Cost control: every suggestion request AND the one field-masked Place
   Details call after a selection share a single AutocompleteSessionToken
   (created on the first keystroke of a fresh interaction, discarded right
   after that Details call) -- per Google's session-pricing model this bills
   as ONE session for a whole type-then-select interaction, not one request
   per keystroke. The Details call itself only asks for `addressComponents`
   (fetchFields' field mask) -- never ratings/reviews/photos/opening-hours/
   other business-detail fields, which live in a pricier SKU tier.

   MISSING/INVALID KEY: same graceful-degradation contract as before this
   file used a real key -- if importLibrary() ever rejects (revoked key,
   wrong API enabled, referrer mismatch, offline), every Address field just
   stays the plain text input it already is; nothing here throws or blocks
   typing in the meantime, since the dropdown is pure addition on top of the
   input, not a replacement of it. */
(function () {
  const GOOGLE_PLACES_API_KEY = 'AIzaSyCAQiXBoQuT94R3DH3NhPYJmF3NvRmFAi0';

  if (!GOOGLE_PLACES_API_KEY || GOOGLE_PLACES_API_KEY === 'YOUR_GOOGLE_PLACES_API_KEY_HERE') return;

  const addressInputs = Array.from(document.querySelectorAll('input[name="address"]'));
  if (!addressInputs.length) return;

  // Official Google-provided bootstrap loader (loading=async pattern) --
  // injects the real https://maps.googleapis.com/maps/api/js script on first
  // use and resolves google.maps.importLibrary() once it's ready. Shared
  // across every Address input on the page (only ever runs once).
  let placesLibraryPromise = null;
  function loadPlacesLibrary() {
    if (placesLibraryPromise) return placesLibraryPromise;
    placesLibraryPromise = new Promise((resolve, reject) => {
      (g => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams, u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, t => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a) })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)) })({ key: GOOGLE_PLACES_API_KEY, v: "weekly" });
      window.google.maps.importLibrary('places').then(resolve, reject);
    }).catch((err) => { placesLibraryPromise = null; throw err; });
    return placesLibraryPromise;
  }

  // Same address-component parsing as before (street_number + route ->
  // Address, locality/postal_town -> City, postal_code -> Postal Code) --
  // just reading Places API (New)'s camelCase addressComponents/longText
  // shape instead of the legacy address_components/long_name shape. Also
  // pulls the `country` component's shortText (its ISO 3166-1 alpha-2 code,
  // e.g. "FR"/"BE" -- the same vocabulary the Country <select>'s own
  // <option value="FR"/"BE"> already uses) so callers can cross-check/
  // auto-sync the Country field against what was actually selected.
  function parseAddressComponents(components) {
    const get = (type) => {
      const comp = components.find((c) => c.types.includes(type));
      return comp ? comp.longText : '';
    };
    const streetNumber = get('street_number');
    const route = get('route');
    const city = get('locality') || get('postal_town');
    const postal = get('postal_code');
    const countryComp = components.find((c) => c.types.includes('country'));
    const countryCode = countryComp ? countryComp.shortText.toUpperCase() : '';
    return { address: `${streetNumber} ${route}`.trim(), city, postal, countryCode };
  }

  function fireInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function enhance(input) {
    let placesLib;
    try {
      placesLib = await loadPlacesLibrary();
    } catch (err) {
      return; // stays a plain text input
    }
    const { AutocompleteSessionToken, AutocompleteSuggestion } = placesLib;
    const form = input.closest('form') || document;

    // Suggestions render as a positioned panel below the input, same visual
    // convention as this page's other dropdown (.phone-country-panel, see
    // js/phone-input.js) -- anchored to .checkout-field so it isn't clipped
    // by/doesn't reflow the field-row layout it may share with a sibling
    // field (City sits next to Postal Code, but Address is always alone in
    // its own row, so this never has a horizontal neighbor to worry about).
    const anchor = input.closest('.checkout-field') || input.parentNode;
    anchor.classList.add('monark-places-anchor');
    const panel = document.createElement('ul');
    panel.className = 'monark-places-suggestions';
    panel.setAttribute('role', 'listbox');
    panel.hidden = true;
    anchor.appendChild(panel);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-autocomplete', 'list');
    // Chrome deliberately ignores autocomplete="off" on address-shaped
    // fields (confirmed via extensive real-device testing elsewhere in this
    // codebase -- see checkout.html's/account.html's own Address Line 2
    // field comments) and will still render its own native saved-address
    // autofill dropdown here regardless of this attribute, sometimes
    // visibly overlapping this panel. Left in place anyway: Chrome's own
    // heuristic is genuinely name/label-driven, not attribute-driven, but
    // other browsers (Firefox, Safari) DO still respect "off", and this
    // field's real name="address" is exactly the semantic hook every one of
    // those heuristics keys off of -- renaming it away (the fix that worked
    // for Address Line 2) isn't an option here, since unlike that field,
    // Chrome's native autofill on THIS one is a wanted feature (see its own
    // autocomplete="street-address" in the HTML, tuned over 5 rounds
    // specifically to make that native autofill work for anyone this
    // in-page panel doesn't reach, e.g. before the Places library has
    // loaded). Chrome's native popup is rendered by the browser chrome
    // itself, entirely outside this page's DOM/paint layer -- no CSS
    // z-index, position, or JS reaches it from here, so two levers are used
    // together instead: making sure THIS panel visibly wins any overlap
    // (dark/bronze branded surface + border + shadow + a defensively high
    // z-index, see css/checkout.css's .monark-places-suggestions), and a
    // best-effort blur()+focus() cycle right as this panel is about to open
    // that often closes Chrome's native popup outright -- see
    // dismissNativeAutofillPopup() below.
    input.setAttribute('autocomplete', 'off');

    let sessionToken = null;
    let suggestions = [];
    let activeIndex = -1;
    let debounceTimer = null;
    let requestId = 0;
    // Set right before this file programmatically writes input.value +
    // fires a synthetic 'input' event on it (see fireInput() call sites
    // below) -- without this, that synthetic event re-enters the real-typed
    // 'input' listener just below, which re-ran a fresh suggestions search
    // for the address text that was JUST selected and reopened the panel
    // right after selectSuggestion() had closed it (the actual cause behind
    // "the dropdown stays open after picking a suggestion").
    let suppressNextInputEvent = false;
    // Set around the synthetic blur()+focus() cycle in
    // dismissNativeAutofillPopup() below, so the input's own real blur
    // handler (further down) -- which schedules closePanel() for when the
    // user actually leaves the field -- doesn't also fire for this
    // momentary, purely-internal blur.
    let suppressBlurClose = false;

    // Country <select> this Address field's form actually has, if any --
    // checkout.html's Shipping section has one (name="country"); account.html's
    // Saved Address form doesn't (its country is only ever implied by the
    // phone widget's own dial-code selection, see checkout.html's own
    // comment on account.country), so this is null there and every use of
    // it below is already guarded for that.
    const countryInput = form.querySelector('[name="country"]');

    function closePanel() {
      panel.hidden = true;
      panel.innerHTML = '';
      suggestions = [];
      activeIndex = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function renderPanel() {
      panel.innerHTML = suggestions.map((s, i) => {
        const text = s.placePrediction && s.placePrediction.text ? s.placePrediction.text.text : '';
        return `<li role="option" id="monark-places-opt-${i}" data-index="${i}">${text}</li>`;
      }).join('');
      panel.hidden = suggestions.length === 0;
      input.setAttribute('aria-expanded', String(suggestions.length > 0));
    }

    // Best-effort mitigation for Chrome's own native address-autofill
    // suggestion popup visually overlapping this panel (see this file's
    // autocomplete="off" comment above for why that attribute alone can't
    // prevent it) -- blur()+focus() in the same synchronous tick is a known
    // trick that often collapses Chrome's native popup, since it's tied to
    // the field's current focus session, WITHOUT disabling native autofill
    // outright (it can still reappear on the next fresh focus, which is the
    // point -- anyone this in-page panel doesn't reach, e.g. before the
    // Places library has loaded, keeps that fallback). Only called right
    // before this panel is about to go from closed to open (see its one
    // call site below), not on every keystroke while it's already open, so
    // a fast typist doesn't get a blur/focus cycle on every letter.
    // Selection is saved/restored around it since blur() natively clears
    // it and it isn't reliably preserved through a refocus on its own.
    function dismissNativeAutofillPopup() {
      if (document.activeElement !== input) return;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const direction = input.selectionDirection;
      suppressBlurClose = true;
      input.blur();
      input.focus();
      suppressBlurClose = false;
      if (start !== null && end !== null) {
        try { input.setSelectionRange(start, end, direction || 'none'); } catch (err) { /* non-text input types can throw -- N/A here, kept defensive */ }
      }
    }

    function highlight() {
      Array.from(panel.children).forEach((li, i) => li.classList.toggle('is-highlighted', i === activeIndex));
      input.setAttribute('aria-activedescendant', activeIndex >= 0 ? `monark-places-opt-${activeIndex}` : '');
    }

    async function selectSuggestion(index) {
      const suggestion = suggestions[index];
      if (!suggestion || !suggestion.placePrediction) return;
      const place = suggestion.placePrediction.toPlace();
      try {
        // Field mask restricted to ONLY the address-component data this form
        // needs -- see this file's own header comment on why. sessionToken
        // here is the same token used for the fetchAutocompleteSuggestions
        // calls above, closing out this interaction as a single billed
        // session; a new one is created lazily next time the user types.
        await place.fetchFields({ fields: ['addressComponents'], sessionToken });
      } catch (err) {
        closePanel();
        return;
      }
      sessionToken = null;
      const { address, city, postal, countryCode } = parseAddressComponents(place.addressComponents || []);
      suppressNextInputEvent = true;
      if (address) input.value = address;
      fireInput(input);
      const cityInput = form.querySelector('[name="city"]');
      if (cityInput && city) { cityInput.value = city; fireInput(cityInput); }
      const postalInput = form.querySelector('[name="postal"]');
      if (postalInput && postal) { postalInput.value = postal; fireInput(postalInput); }
      // Cross-check target for checkout.html's own submit-time validation
      // (validateShippingForm() there reads this same attribute) -- records
      // whichever country this selection actually resolved to, even when
      // it's neither France nor Belgium, so a selected-but-out-of-scope
      // address can still be caught at submit rather than silently
      // accepted. Cleared the moment the user edits the address by hand
      // again (see the real-typing branch of the 'input' listener below),
      // so a stale country claim never outlives the selection it came from.
      if (countryCode) {
        input.dataset.placesCountry = countryCode;
      } else {
        delete input.dataset.placesCountry;
      }
      // Auto-syncs the Country <select> to match the selected address's
      // real country -- same spirit as the postal-code-driven autofill sync
      // just below in checkout.html's own inline script, but triggered by
      // an explicit Places selection instead of Chrome's autofill firing.
      // Only ever moves it to a value the <select> actually offers (FR/BE);
      // an out-of-scope country is left for the submit-time check above to
      // catch instead of forced into a wrong-but-supported option here.
      if (countryInput && (countryCode === 'FR' || countryCode === 'BE') && countryInput.value !== countryCode) {
        countryInput.value = countryCode;
        countryInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      closePanel();
    }

    input.addEventListener('input', () => {
      if (suppressNextInputEvent) { suppressNextInputEvent = false; return; }
      // Real user edit -- whatever country a previous selection resolved to
      // no longer describes the (now different) address text, so it can't
      // be cross-checked against at submit time anymore either.
      delete input.dataset.placesCountry;
      clearTimeout(debounceTimer);
      const query = input.value.trim();
      if (!query) { closePanel(); return; }
      const thisRequest = ++requestId;
      debounceTimer = setTimeout(async () => {
        if (!sessionToken) sessionToken = new AutocompleteSessionToken();
        let response;
        try {
          response = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: query,
            sessionToken,
            // Restricted to a real street address (not businesses/POIs/pure
            // regions). Region restriction is read fresh on every request
            // (not hardcoded) -- narrows to whichever single country is
            // currently selected in the Country <select>, when this form
            // has one and it's set, so suggestions stop including addresses
            // in the OTHER supported country the moment the customer has
            // already told us which one they mean; only falls back to both
            // France + Belgium when there's no country selection yet to
            // narrow by (e.g. account.html's Saved Address form, which has
            // no Country field at all). Doesn't change session billing
            // either way -- purely a relevance/scope filter on top of the
            // one still-open session token.
            includedPrimaryTypes: ['street_address'],
            includedRegionCodes: countryInput && countryInput.value
              ? [countryInput.value.toLowerCase()]
              : ['fr', 'be']
          });
        } catch (err) {
          return;
        }
        if (thisRequest !== requestId) return; // stale response from an earlier keystroke
        const nextSuggestions = (response && response.suggestions) || [];
        // "About to show new results" means specifically going from closed
        // to open -- checked BEFORE suggestions/panel state below are
        // updated, so a keystroke that just refreshes an ALREADY-open
        // panel's contents (the common case while typing) never re-triggers
        // the blur/focus cycle above, only the first one that actually
        // opens it.
        const isFreshOpen = panel.hidden && nextSuggestions.length > 0;
        suggestions = nextSuggestions;
        activeIndex = -1;
        if (isFreshOpen) dismissNativeAutofillPopup();
        renderPanel();
      }, 200);
    });

    input.addEventListener('keydown', (e) => {
      if (panel.hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, suggestions.length - 1);
        highlight();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        highlight();
      } else if (e.key === 'Enter') {
        if (activeIndex >= 0) { e.preventDefault(); selectSuggestion(activeIndex); }
      } else if (e.key === 'Escape') {
        closePanel();
      }
    });

    // mousedown (not click) fires before the input's own blur handler below,
    // so the selection still has a live suggestions list to read from --
    // e.preventDefault() here stops that blur from happening at all.
    panel.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      e.preventDefault();
      selectSuggestion(Number(li.dataset.index));
    });

    // Closes on blur (e.g. Tab to the next field) -- delayed just long
    // enough for the mousedown handler above to have already run for a
    // click landing inside the panel. Skipped for the synthetic blur inside
    // dismissNativeAutofillPopup() above (suppressBlurClose) -- that one is
    // immediately followed by a refocus in the same tick and was never the
    // user actually leaving the field.
    input.addEventListener('blur', () => {
      if (suppressBlurClose) return;
      setTimeout(closePanel, 150);
    });
  }

  addressInputs.forEach(enhance);
})();
