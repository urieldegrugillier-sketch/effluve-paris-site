/* MONARK — Google Places Autocomplete on the "Address" field (checkout.html's
   Shipping section, account.html's Saved Address form). Shared across both
   pages: it just enhances every `input[name="address"]` it finds, so neither
   page needs its own copy of this logic.

   PLACEHOLDER API KEY -- replace GOOGLE_PLACES_API_KEY below with a real key
   generated via Google Cloud Console (APIs & Services > Credentials), with
   the "Places API" enabled and HTTP referrer restrictions locked to this
   site's real domain(s) before launch. Until then this key stays the literal
   placeholder string on purpose: Google's loader script still exists (any
   key, even a fake one, gets *some* response), but actually invoking a
   Places call with an invalid key logs its own console errors from inside
   Google's code, well after this script's `onerror` has already had its one
   chance to fire -- so rather than loading the script anyway and hoping to
   catch that failure after the fact, this checks the key BEFORE ever making
   the network request at all, and simply never loads Google's script if it's
   still the placeholder. Either way (missing key, invalid key, or the
   network request itself failing), every Address field just stays the plain
   text input it already is -- graceful degradation is the default state,
   not a fallback path this code has to actively detect and switch into. */
(function () {
  const GOOGLE_PLACES_API_KEY = 'YOUR_GOOGLE_PLACES_API_KEY_HERE';

  if (!GOOGLE_PLACES_API_KEY || GOOGLE_PLACES_API_KEY === 'YOUR_GOOGLE_PLACES_API_KEY_HERE') return;

  const script = document.createElement('script');
  script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(GOOGLE_PLACES_API_KEY) + '&libraries=places&callback=initMonarkPlacesAutocomplete';
  script.async = true;
  // Network-level failures (blocked, offline, bad domain) land here -- a
  // valid-looking key that Google itself rejects at request time (revoked,
  // wrong API enabled, referrer mismatch) instead just never calls the
  // callback below, which is an equally silent degrade to plain text.
  script.onerror = function () { /* Address field(s) stay plain text inputs */ };
  document.head.appendChild(script);

  // Maps each Autocomplete's selected place onto the OTHER shipping/address
  // fields living in the same <form> as its Address input, when present --
  // city/postal on both checkout.html and account.html, nothing else (no
  // "state"/"country" field exists on this site's forms to fill).
  function applyPlaceToForm(place, form) {
    if (!place || !Array.isArray(place.address_components)) return;
    const get = (type) => {
      const comp = place.address_components.find((c) => c.types.includes(type));
      return comp ? comp.long_name : '';
    };
    const streetNumber = get('street_number');
    const route = get('route');
    const city = get('locality') || get('postal_town');
    const postal = get('postal_code');

    const addressInput = form.querySelector('[name="address"]');
    const cityInput = form.querySelector('[name="city"]');
    const postalInput = form.querySelector('[name="postal"]');

    if (addressInput && (streetNumber || route)) addressInput.value = `${streetNumber} ${route}`.trim();
    if (cityInput && city) cityInput.value = city;
    if (postalInput && postal) postalInput.value = postal;
  }

  window.initMonarkPlacesAutocomplete = function () {
    if (!window.google || !google.maps || !google.maps.places) return;
    document.querySelectorAll('input[name="address"]').forEach((input) => {
      const form = input.closest('form');
      const autocomplete = new google.maps.places.Autocomplete(input, { types: ['address'] });
      autocomplete.addListener('place_changed', () => {
        applyPlaceToForm(autocomplete.getPlace(), form || document);
      });
    });
  };
})();
