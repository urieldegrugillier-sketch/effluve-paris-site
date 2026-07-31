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
  // shape instead of the legacy address_components/long_name shape.
  function parseAddressComponents(components) {
    const get = (type) => {
      const comp = components.find((c) => c.types.includes(type));
      return comp ? comp.longText : '';
    };
    const streetNumber = get('street_number');
    const route = get('route');
    const city = get('locality') || get('postal_town');
    const postal = get('postal_code');
    return { address: `${streetNumber} ${route}`.trim(), city, postal };
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
    input.setAttribute('autocomplete', 'off'); // stop native/browser suggestions competing with this panel

    let sessionToken = null;
    let suggestions = [];
    let activeIndex = -1;
    let debounceTimer = null;
    let requestId = 0;

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
      const { address, city, postal } = parseAddressComponents(place.addressComponents || []);
      if (address) input.value = address;
      fireInput(input);
      const cityInput = form.querySelector('[name="city"]');
      if (cityInput && city) { cityInput.value = city; fireInput(cityInput); }
      const postalInput = form.querySelector('[name="postal"]');
      if (postalInput && postal) { postalInput.value = postal; fireInput(postalInput); }
      closePanel();
    }

    input.addEventListener('input', () => {
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
            // regions) and to the two countries this site ships to (see
            // checkout.html's <select name="country">) -- a relevance/scope
            // filter only, doesn't change session billing either way.
            includedPrimaryTypes: ['street_address'],
            includedRegionCodes: ['fr', 'be']
          });
        } catch (err) {
          return;
        }
        if (thisRequest !== requestId) return; // stale response from an earlier keystroke
        suggestions = (response && response.suggestions) || [];
        activeIndex = -1;
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
    // click landing inside the panel.
    input.addEventListener('blur', () => { setTimeout(closePanel, 150); });
  }

  addressInputs.forEach(enhance);
})();
