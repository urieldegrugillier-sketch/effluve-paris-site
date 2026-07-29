/* Effluve Paris — hover/tap micro-interaction for individual fragrance notes
   (index.html's pyramid tiers, product.html's Top/Heart/Base Notes row, see
   each page's own css/style.css or css/shop.css rules for the .note-word/
   .note-word-wrap/.note-desc styling this toggles). :hover/:focus-visible
   alone already cover desktop mouse and keyboard -- this only adds what
   :hover can't: a tap-to-toggle class for touch devices, via a plain click
   listener (fires for both a real click and a touch tap in every modern
   mobile browser, unlike depending on :hover's own unreliable
   tap-triggering behavior). These are plain <span>s with nowhere to
   navigate to, so there's no tap-to-reveal-then-tap-again-to-follow problem
   a real link would have to design around.

   Self-mounting, no-ops if the page has no .note-word elements -- loaded
   only by index.html/product.html, the two pages that actually have them. */
(function () {
  // Pyramid words (css/style.css) have no wrapper -- product.html's own
  // words (css/shop.css) do, since that's what the description tooltip is
  // positioned relative to. Toggling the wrapper when one exists, the word
  // itself otherwise, keeps one shared listener correct for both.
  function targetFor(word) {
    return word.closest('.note-word-wrap') || word;
  }

  function clearActive() {
    document.querySelectorAll('.note-word-active').forEach((el) => el.classList.remove('note-word-active'));
  }

  function onWordClick(e) {
    // Stops the document-level listener below from immediately clearing
    // what this same click is about to set, once it bubbles up.
    e.stopPropagation();
    const target = targetFor(e.currentTarget);
    const wasActive = target.classList.contains('note-word-active');
    // Only one note "pinned" open at a time -- tapping a second note (or
    // re-tapping the same one) always leaves at most one active, rather
    // than letting several stay highlighted/expanded at once.
    clearActive();
    if (!wasActive) target.classList.add('note-word-active');
  }

  // BUG FIX: these headings/note rows are all data-i18n-html (see
  // js/i18n.js) -- MonarkI18n.apply() replaces their innerHTML wholesale on
  // every language switch, which destroys the exact <span> nodes any
  // previously-attached listeners lived on. Re-binding on every
  // 'monark:langchange' (not just once at load) keeps tap working after a
  // language switch instead of silently going dead.
  function bind() {
    document.querySelectorAll('.note-word').forEach((word) => {
      word.removeEventListener('click', onWordClick);
      word.addEventListener('click', onWordClick);
    });
  }

  if (!document.querySelector('.note-word')) return;
  bind();
  document.addEventListener('monark:langchange', bind);

  // Tapping/clicking anywhere else dismisses whichever note is pinned open,
  // so a description tooltip never stays stuck visible after the user has
  // moved on. Bound once, unlike bind() above -- document itself is never
  // replaced, so this listener is never at risk of going stale.
  document.addEventListener('click', clearActive);
})();
