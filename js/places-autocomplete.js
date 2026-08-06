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

    // Flags checkout.html's/account.html's own submit-time "did you actually
    // pick a suggestion" nudge (see their own validateShippingForm()/
    // addressForm submit handler) reads before deciding whether that gate
    // even applies to this field at all -- Places genuinely never loaded for
    // a visitor otherwise (revoked key, wrong API enabled, referrer
    // mismatch, offline), and requiring a selection from a list that was
    // never there to pick from would just be a bug, not a nudge. Set once,
    // right here, the moment enhance() actually gets this far (i.e. the
    // library resolved) -- never unset for the lifetime of the page, unlike
    // placesSelected below which toggles per keystroke/selection.
    input.dataset.placesEnhanced = 'true';

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
    // z-index, position, or JS reaches it from here.
    //
    // A blur()+focus() cycle right as this panel opened (in an attempt to
    // force Chrome's native popup closed) was tried and reverted -- confirmed
    // on a real device it didn't actually dismiss Chrome's popup, so it was
    // pure downside (an extra focus cycle) for no upside. What's shipped
    // instead: on desktop widths, this panel renders ABOVE the input rather
    // than below (see updatePanelPlacement()) -- Chrome's own native popup
    // renders below/near the field, so putting this one on the opposite side
    // keeps both visible and distinguishable instead of overlapping. Mobile
    // keeps the below placement unchanged (confirmed to already work well
    // there, staying clear of the on-screen keyboard).
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

    // Country <select> this Address field's form actually has, if any --
    // checkout.html's Shipping section has one (name="country"); account.html's
    // Saved Address form doesn't (its country is only ever implied by the
    // phone widget's own dial-code selection, see checkout.html's own
    // comment on account.country), so this is null there and every use of
    // it below is already guarded for that.
    const countryInput = form.querySelector('[name="country"]');

    // Same min-width:769px desktop breakpoint used elsewhere in this
    // codebase for desktop-vs-mobile behavior (see js/app.js's own
    // isDesktop) -- used below both to decide above-vs-below placement and
    // to gate the "Suggestions" label (see renderPanel()). Both exist
    // specifically to help tell this panel apart from Chrome's own native
    // autofill popup, which only ever competes for the same space on
    // desktop -- mobile already works well on its own (stays clear of the
    // on-screen keyboard, confirmed), so neither applies there.
    const isDesktopQuery = window.matchMedia('(min-width: 769px)');

    function closePanel() {
      panel.hidden = true;
      panel.innerHTML = '';
      suggestions = [];
      activeIndex = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    // A non-selectable label row prepended above the actual suggestions --
    // role="presentation" (not "option") keeps it out of the listbox's own
    // selectable set, so every piece of index-based logic below
    // (highlight(), the mousedown handler, keyboard nav) targets
    // '[role="option"]' specifically rather than raw panel.children, which
    // would otherwise be off-by-one the moment this label exists as the
    // first child.
    function renderPanel() {
      const label = suggestions.length && isDesktopQuery.matches
        ? `<li class="monark-places-suggestions-label" role="presentation">${window.MonarkI18n ? window.MonarkI18n.t('common.placesSuggestionsLabel') : 'Suggestions'}</li>`
        : '';
      const items = suggestions.map((s, i) => {
        const text = s.placePrediction && s.placePrediction.text ? s.placePrediction.text.text : '';
        return `<li role="option" id="monark-places-opt-${i}" data-index="${i}">${text}</li>`;
      }).join('');
      panel.innerHTML = label + items;
      panel.hidden = suggestions.length === 0;
      input.setAttribute('aria-expanded', String(suggestions.length > 0));
    }

    // Desktop-only mitigation for Chrome's own native address-autofill
    // popup visually overlapping this panel (see this file's autocomplete=
    // "off" comment above) -- flips this panel to render ABOVE the input
    // instead of below, via the --above modifier class (css/checkout.css),
    // so the two don't compete for the same space under the field. Same
    // min-width:769px desktop breakpoint used elsewhere in this codebase for
    // desktop-vs-mobile behavior (see js/app.js's own isDesktop). Mobile
    // always stays below, unchanged -- confirmed to already work well there,
    // clear of the on-screen keyboard.
    //
    // PANEL_MAX_HEIGHT mirrors .monark-places-suggestions's own CSS
    // max-height (css/checkout.css) -- the panel's own inline max-height
    // (set below) is only ever a SHRINK from that CSS default for whichever
    // side is actually chosen, never a grow past it.
    //
    // BUG FIX round 1: originally required a flat 240px (this same
    // PANEL_MAX_HEIGHT) of room above before placing "above" at all,
    // otherwise falling all the way back to "below" -- which put the panel
    // right back in Chrome's own native-popup space the moment there wasn't
    // quite enough room for the worst-case full-height list, even with real,
    // usable (just smaller) room still available above. Confirmed via direct
    // measurement this is a real, reachable state (not just theoretical): a
    // field sitting near the top of the viewport (e.g. right after its
    // accordion section opens with the page not scrolled down at all yet)
    // can easily have some real room above -- just less than the full
    // 240px -- and no window.scrollY to gain more by scrolling further up.
    // Fixed by placing "above" whenever it has at least PANEL_MIN_HEIGHT to
    // work with, full stop -- deliberately NOT "whichever side has more
    // room": Chrome's native popup only ever renders below the field, so
    // "below" is the one placement actually worth avoiding, and comparing
    // raw pixel counts would still pick "below" any time it slightly
    // out-measures a perfectly usable "above" (e.g. above=250/below=400 --
    // above alone is already enough, picking "below" there would silently
    // reopen the exact overlap this whole mitigation exists to prevent).
    // The panel's own max-height then shrinks to fit whatever the chosen
    // side genuinely has, down to that same PANEL_MIN_HEIGHT floor (a
    // couple of visible rows -- overflow-y:auto still lets a longer result
    // list scroll internally past that, same as the old fixed-240 case
    // already relied on for a result list taller than 240 itself).
    //
    // BUG FIX round 3: round 1's "viable at all" floor turned out to be so
    // low that it effectively became "always above" in ordinary use -- 96px
    // clears easily in nearly every real layout/scroll position (confirmed
    // live: a fresh Shipping-step open with no unusual scrolling already
    // measures 300-450px above by default), so "below" was in practice
    // almost never reachable even though it often had dramatically more
    // room. Concretely reproduced live: above=110/below=500 still chose
    // "above," squeezing the 3-row suggestion list into ~110px directly on
    // top of the Account section summary right above the field, when 500px
    // below would have shown it comfortably -- exactly the "forced above
    // with little room, pushing content awkwardly" symptom this fixes.
    // "Above" now also needs to NOT be clearly worse than "below" -- it
    // still wins outright once it clears the full PANEL_MAX_HEIGHT (a
    // "perfectly usable above," same worked example as round 1's own
    // comment: above=250/below=400 still picks above, since 250 alone is
    // already enough -- round 1's own reasoning holds unchanged there), but
    // below that, it only wins if it's not smaller than "below" either --
    // restoring an actual space comparison for the narrow, genuinely
    // ambiguous case round 1 didn't have to consider (a small-but-viable
    // above going up against a much roomier below), while still never
    // preferring "below" over an above that's already spacious enough on
    // its own, which is what round 1 set out to prevent in the first place.
    //
    // BUG FIX round 2: re-opening a completed accordion step (e.g. Shipping,
    // after visiting Payment and clicking back) never scrolls that step back
    // into view on its own (no browser default for it, and this codebase's
    // own accordion code doesn't add one), so the field can simply be
    // sitting at whatever scroll position was last left over from being
    // further down the page. Scrolling the field into a centered view before
    // the real placement decision -- but ONLY when the current position
    // both has less than the full PANEL_MAX_HEIGHT above AND has room to
    // scroll further up in the first place (window.scrollY > 0) -- gives
    // round 1's above-viability check the most room it can actually get
    // before deciding, without ever forcing a scroll on a field that's
    // genuinely near the top of the page's own content (scrollY already 0),
    // where scrolling up further wouldn't help anyway.
    const PANEL_MAX_HEIGHT = 240;
    const PANEL_MIN_HEIGHT = 96;
    function availableRoom() {
      const inputRect = input.getBoundingClientRect();
      const header = document.querySelector('.site-header');
      const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
      return { above: inputRect.top - headerBottom, below: window.innerHeight - inputRect.bottom };
    }
    function updatePanelPlacement() {
      if (!isDesktopQuery.matches) {
        panel.classList.remove('monark-places-suggestions--above');
        panel.style.maxHeight = '';
        return;
      }
      let { above, below } = availableRoom();
      if (above < PANEL_MAX_HEIGHT && window.scrollY > 0) {
        input.scrollIntoView({ block: 'center', behavior: 'auto' });
        ({ above, below } = availableRoom());
      }
      // See "BUG FIX round 3" above: "above" needs the PANEL_MIN_HEIGHT
      // floor to be viable at all, and then either enough room to be fully
      // comfortable on its own (>= PANEL_MAX_HEIGHT -- Chrome's overlap
      // avoidance wins outright here, no comparison needed) or at least as
      // much room as "below" actually has (a genuine space comparison for
      // the in-between case, so a barely-viable "above" stops beating a
      // dramatically roomier "below").
      const goAbove = above >= PANEL_MIN_HEIGHT && (above >= PANEL_MAX_HEIGHT || above >= below);
      panel.classList.toggle('monark-places-suggestions--above', goAbove);
      const usable = goAbove ? above : below;
      panel.style.maxHeight = usable < PANEL_MAX_HEIGHT ? `${Math.max(PANEL_MIN_HEIGHT, usable - 8)}px` : '';
    }

    function highlight() {
      Array.from(panel.querySelectorAll('[role="option"]')).forEach((li, i) => li.classList.toggle('is-highlighted', i === activeIndex));
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
      // Marks the CURRENT input value as one actually picked from this
      // panel, not free-typed -- read by checkout.html's/account.html's own
      // submit-time nudge (see placesEnhanced's own comment above) to decide
      // whether to require a selection at all. Cleared the instant the user
      // edits the address by hand again (see the 'input' listener below),
      // same lifetime as placesCountry just above, since both describe
      // properties of this exact selection that a hand-edit invalidates.
      input.dataset.placesSelected = 'true';
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
      // be cross-checked against at submit time anymore either. Same for
      // placesSelected -- this value is no longer the one that was picked
      // from the list, so the submit-time nudge should treat it as
      // free-typed again.
      delete input.dataset.placesCountry;
      delete input.dataset.placesSelected;
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
        // Placement is (re)decided only on a closed -> open transition --
        // checked BEFORE suggestions/panel state below are updated -- not on
        // every keystroke while it's already open, so the panel doesn't hop
        // from one side of the input to the other mid-typing.
        const isFreshOpen = panel.hidden && nextSuggestions.length > 0;
        suggestions = nextSuggestions;
        activeIndex = -1;
        if (isFreshOpen) updatePanelPlacement();
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
      const li = e.target.closest('li[role="option"]');
      if (!li) return; // includes a click landing on the non-selectable label row
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
