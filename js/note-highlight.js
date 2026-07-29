/* Effluve Paris — hover/tap micro-interaction for individual fragrance notes
   (index.html's pyramid tiers, product.html's Top/Heart/Base Notes row, see
   each page's own css/style.css or css/shop.css rules for the .note-word/
   .note-word-wrap/.note-desc styling this toggles).

   BUG FIX: previously, click-toggling .note-word-active (below) and CSS's
   own :hover/:focus-visible selectors ran completely independently -- each
   could reveal a description tooltip with no awareness of the other, so
   clicking one note then hovering a different one left BOTH open at once
   (confirmed live on product.html). Fixed by moving every trigger (click,
   hover, keyboard focus) into this one JS state machine -- .note-word-active
   is now the ONLY thing either page's CSS keys the tooltip reveal off of
   (see the .note-desc rules in css/shop.css -- css/style.css's pyramid
   version has no tooltip to conflict, only a color/underline, so it's
   unaffected either way), so there's exactly one source of truth for
   "which note is currently showing," regardless of input method.

   `pinned` (click/tap) persists until re-toggled, a different note is
   clicked, or a click lands outside every note. `preview` (hover/keyboard
   focus) is transient -- it wins while active (even over a pinned note, so
   moving the mouse to a different word always shows THAT word, per the bug
   report), then falls back to whatever's pinned (if anything) once the
   mouse/focus leaves. render() below is the single place that reconciles
   the two into one visible .note-word-active at a time.

   Self-mounting, no-ops if the page has no .note-word elements -- loaded
   only by index.html/product.html, the two pages that actually have them. */
(function () {
  function targetFor(word) {
    return word.closest('.note-word-wrap') || word;
  }

  let pinned = null;
  let preview = null;

  function render() {
    const shouldShow = preview || pinned;
    document.querySelectorAll('.note-word-active').forEach((el) => {
      if (el !== shouldShow) el.classList.remove('note-word-active');
    });
    if (shouldShow) shouldShow.classList.add('note-word-active');
  }

  function clearAll() {
    pinned = null;
    preview = null;
    render();
  }

  function onClick(e) {
    // Stops the document-level listener below from immediately clearing
    // what this same click is about to set, once it bubbles up.
    e.stopPropagation();
    const target = targetFor(e.currentTarget);
    // BUG FIX: a click always lands on whatever's currently hovered (you
    // can't click something your pointer isn't over) -- touch devices
    // additionally fire a synthetic mouseenter as part of the SAME tap that
    // fires click (confirmed live on WebKit/iOS: tapping an already-open
    // note a second time, to toggle it closed, silently did nothing). If
    // preview isn't also cleared here when un-pinning THIS SAME target,
    // render()'s preview-wins-over-pinned priority (needed so hovering a
    // DIFFERENT note always shows it, even over something pinned) keeps
    // showing it anyway, making the click look like it did nothing.
    if (pinned === target) {
      pinned = null;
      if (preview === target) preview = null;
    } else {
      pinned = target;
      preview = target;
    }
    render();
  }

  function onEnter(e) {
    preview = targetFor(e.currentTarget);
    render();
  }

  function onLeave(e) {
    if (preview === targetFor(e.currentTarget)) preview = null;
    render();
  }

  // Keyboard focus gets the exact same preview/pinned treatment as mouse
  // hover -- tabbing onto a different note while another is pinned open
  // would otherwise be the same "two shown at once" bug via the keyboard
  // instead of the mouse.
  function onFocus(e) {
    preview = targetFor(e.currentTarget);
    render();
  }

  function onBlur(e) {
    if (preview === targetFor(e.currentTarget)) preview = null;
    render();
  }

  // BUG FIX: these headings/note rows are all data-i18n-html (see
  // js/i18n.js) -- MonarkI18n.apply() replaces their innerHTML wholesale on
  // every language switch, which destroys the exact <span> nodes any
  // previously-attached listeners lived on. Re-binding on every
  // 'monark:langchange' (not just once at load) keeps this working after a
  // language switch instead of silently going dead. clearAll() first since
  // the old (about-to-be-destroyed) nodes can't stay referenced as
  // pinned/preview across the rebuild.
  function bind() {
    document.querySelectorAll('.note-word').forEach((word) => {
      word.removeEventListener('click', onClick);
      word.removeEventListener('mouseenter', onEnter);
      word.removeEventListener('mouseleave', onLeave);
      word.removeEventListener('focus', onFocus);
      word.removeEventListener('blur', onBlur);
      word.addEventListener('click', onClick);
      word.addEventListener('mouseenter', onEnter);
      word.addEventListener('mouseleave', onLeave);
      word.addEventListener('focus', onFocus);
      word.addEventListener('blur', onBlur);
    });
  }

  if (!document.querySelector('.note-word')) return;
  bind();
  document.addEventListener('monark:langchange', () => { clearAll(); bind(); });

  // Tapping/clicking anywhere else dismisses whichever note is pinned open,
  // so a description tooltip never stays stuck visible after the user has
  // moved on.
  //
  // BUG FIX: this used to listen for 'click', which never fired at all for
  // an outside tap on a real device (confirmed live on WebKit/iOS via a
  // full event trace) -- WebKit only synthesizes a click event from a tap
  // for elements it considers "clickable" (links, buttons, form controls,
  // or anything with cursor:pointer/a click handler); a tap on a plain,
  // non-interactive element like the "The Composition" label next to these
  // notes produced pointerdown/touchstart/touchend but no click at all, so
  // the tooltip never dismissed. pointerdown is a low-level Pointer Events
  // primitive that fires for every press regardless of the target's
  // "clickability," on both mouse and touch, and fires before a note-word's
  // own click handler -- skipping it here for anything inside a note-word
  // leaves that element's own click-driven pin/toggle logic as the sole
  // authority over its own state.
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.note-word')) return;
    clearAll();
  });
})();
