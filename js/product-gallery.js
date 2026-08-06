(function () {
  const carousel = document.getElementById('shop-carousel');
  if (!carousel) return;
  const track = carousel.querySelector('.shop-carousel-track');
  const slides = carousel.querySelectorAll('.shop-carousel-slide');
  const dots = carousel.querySelectorAll('.carousel-dot');
  const prevBtn = carousel.querySelector('.carousel-arrow-prev');
  const nextBtn = carousel.querySelector('.carousel-arrow-next');
  const count = slides.length;
  let current = 0;

  function goTo(index) {
    current = (index + count) % count;
    track.style.transform = `translateX(-${current * 100}%)`;
    dots.forEach((dot, i) => dot.classList.toggle('active', i === current));
    if (lightboxOpen) updateLightboxImage();
  }

  prevBtn.addEventListener('click', () => goTo(current - 1));
  nextBtn.addEventListener('click', () => goTo(current + 1));
  dots.forEach((dot, i) => dot.addEventListener('click', () => goTo(i)));

  /* Touch swipe left/right to change slides. The axis is decided once, the
     first time movement clears a small deadzone (10px) -- comparing raw
     per-event deltas instead would flip-flop mid-gesture on a diagonal
     swipe. Only once it's decided horizontal do we preventDefault() on
     touchmove (blocking the page's own vertical scroll for the rest of that
     gesture) -- a gesture decided vertical is never touched at all, so
     normal page scrolling through this carousel is unaffected. Distance and
     duration thresholds on touchend guard against a slow drag or a stray
     few-px wobble registering as a swipe. */
  const SWIPE_MIN_DISTANCE = 40;
  const SWIPE_MAX_DURATION = 600;
  const SWIPE_AXIS_DEADZONE = 10;
  let touchStartX = 0, touchStartY = 0, touchStartTime = 0, swipeAxis = null;

  carousel.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
    swipeAxis = null;
  }, { passive: true });

  carousel.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    if (swipeAxis === null && (Math.abs(dx) > SWIPE_AXIS_DEADZONE || Math.abs(dy) > SWIPE_AXIS_DEADZONE)) {
      swipeAxis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (swipeAxis === 'x') e.preventDefault();
  }, { passive: false });

  carousel.addEventListener('touchend', (e) => {
    const axis = swipeAxis;
    swipeAxis = null;
    if (axis !== 'x') return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const elapsed = Date.now() - touchStartTime;
    if (Math.abs(dx) < SWIPE_MIN_DISTANCE || elapsed > SWIPE_MAX_DURATION) return;
    goTo(current + (dx < 0 ? 1 : -1));
  });

  let isCarouselHovered = false;
  carousel.addEventListener('mouseenter', () => { isCarouselHovered = true; });
  carousel.addEventListener('mouseleave', () => { isCarouselHovered = false; });

  // Single document-level listener covers both mouse-hover (no focus needed) and
  // keyboard-tab focus, so a hovered + focused carousel doesn't fire goTo() twice.
  // When the lightbox is open it takes over left/right entirely, regardless of
  // hover/focus state on the (now visually hidden-behind-it) main carousel.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (lightboxOpen) {
      e.preventDefault();
      goTo(current + (e.key === 'ArrowRight' ? 1 : -1));
      return;
    }
    if (!isCarouselHovered && !carousel.contains(document.activeElement)) return;
    e.preventDefault();
    goTo(current + (e.key === 'ArrowRight' ? 1 : -1));
  });

  /* ---------------- Lightbox: zoom / pan viewer ----------------
     Reuses this same closure's `slides`/`current`/`goTo` so the lightbox and the
     main carousel can never drift out of sync — navigating inside the lightbox
     moves the real carousel too (goTo already updates the track + dots), and
     closing it just leaves the main carousel wherever the user browsed to. */
  const lightbox = document.getElementById('lightbox');
  if (!lightbox) return;
  const stage = document.getElementById('lightbox-stage');
  const lbImage = document.getElementById('lightbox-image');
  const lbClose = lightbox.querySelector('.lightbox-close');
  const lbPrev = lightbox.querySelector('.lightbox-arrow-prev');
  const lbNext = lightbox.querySelector('.lightbox-arrow-next');

  let lightboxOpen = false;
  let scale = 1, tx = 0, ty = 0;
  const MIN_SCALE = 1, MAX_SCALE = 4;
  const pointers = new Map(); // pointerId -> {x, y}, tracks up to 2 for pinch
  let dragLast = null;
  let pinchStartDist = null;

  function applyTransform() {
    lbImage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    lbImage.style.cursor = scale > 1 ? 'grab' : 'auto';
  }

  function resetZoom() {
    scale = 1; tx = 0; ty = 0;
    applyTransform();
  }

  function updateLightboxImage() {
    const img = slides[current].querySelector('.shop-product-image');
    lbImage.src = img.src;
    lbImage.alt = img.alt;
  }

  let lightboxOpener = null; // whatever had focus (or was clicked) before opening -- restored on close

  function openLightbox(index) {
    lightboxOpener = document.activeElement;
    goTo(index);
    updateLightboxImage();
    resetZoom();
    lightboxOpen = true;
    lightbox.setAttribute('aria-hidden', 'false');
    lightbox.classList.add('lightbox-open');
    requestAnimationFrame(() => lightbox.classList.add('lightbox-visible'));
    document.body.style.overflow = 'hidden';
    lbClose.focus();
  }

  function closeLightbox() {
    lightboxOpen = false;
    lightbox.classList.remove('lightbox-visible');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    resetZoom();
    setTimeout(() => { if (!lightboxOpen) lightbox.classList.remove('lightbox-open'); }, 250);
    if (lightboxOpener && typeof lightboxOpener.focus === 'function') lightboxOpener.focus();
  }

  // Keeps Tab/Shift+Tab cycling within the lightbox's own controls instead of
  // leaking out to the (still-present-in-the-DOM, just visually covered) page
  // behind it.
  function trapLightboxTab(e) {
    if (e.key !== 'Tab' || !lightboxOpen) return;
    const focusable = [lbClose, lbPrev, lbNext];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  slides.forEach((slide, i) => {
    const img = slide.querySelector('.shop-product-image');
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', () => openLightbox(i));
    img.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(i); }
    });
  });

  lbClose.addEventListener('click', closeLightbox);
  lbPrev.addEventListener('click', () => goTo(current - 1));
  lbNext.addEventListener('click', () => goTo(current + 1));
  lightbox.addEventListener('keydown', trapLightboxTab);

  // Backdrop-close and tap-to-zoom (below) are both driven from the same pointer
  // tracking rather than a plain native `click` listener: stage.setPointerCapture()
  // (needed for pinch/pan) retargets the pointerup AND the resulting click event's
  // target to `stage` itself for the ENTIRE gesture, even when it started on the
  // image -- so an `e.target === stage` check on a `click` listener would fire on
  // every tap inside the lightbox, image included, and always close it. Tracking
  // where the gesture *started* (in pointerdown, before any capture applies)
  // avoids that entirely.

  document.addEventListener('keydown', (e) => {
    if (lightboxOpen && e.key === 'Escape') closeLightbox();
  });

  // Keeps whatever content point is under (clientX, clientY) visually fixed in
  // place while scale changes -- standard "zoom toward cursor/pinch-midpoint" math.
  function zoomAt(clientX, clientY, factor) {
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    if (newScale === scale) return;
    const f = newScale / scale;
    const rect = stage.getBoundingClientRect(); // stage itself never transforms, a stable reference frame
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    tx = dx * (1 - f) + f * tx;
    ty = dy * (1 - f) + f * ty;
    scale = newScale;
    if (scale === MIN_SCALE) { tx = 0; ty = 0; }
    applyTransform();
  }

  stage.addEventListener('wheel', (e) => {
    if (!lightboxOpen) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0018);
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false });

  // Click/tap-to-zoom: a quick, simple alternative to wheel/pinch -- toggles
  // between "fit" (scale 1) and a fixed CLICK_ZOOM_SCALE, centered on wherever
  // was pressed. Built on the same pointer tracking as pan/pinch (not a plain
  // native `click` listener) so a real drag never gets misread as a tap-to-zoom:
  // TAP_MOVE_TOLERANCE px of movement between pointerdown and pointerup cancels
  // the tap, same distinction most touch UIs make between a tap and a drag.
  const CLICK_ZOOM_SCALE = 2;
  const TAP_MOVE_TOLERANCE = 6;
  let tapCandidate = null;

  function toggleZoomAt(clientX, clientY) {
    if (scale > MIN_SCALE) {
      resetZoom();
    } else {
      zoomAt(clientX, clientY, CLICK_ZOOM_SCALE / scale);
    }
  }

  stage.addEventListener('pointerdown', (e) => {
    if (!lightboxOpen) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Throws NotFoundError in edge cases where the browser no longer considers
    // this pointer id active by the time capture is requested -- harmless to
    // skip capture then (pan/pinch just won't engage for that gesture), but it
    // must not abort the tap-tracking below, which drives close/zoom-toggle.
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    if (pointers.size === 1) {
      // onImage records where the gesture STARTED, before pointer capture can
      // retarget anything -- a clean (non-moved) tap replays that as either a
      // zoom toggle (started on the image) or a close (started on the bare
      // dimmed backdrop), decided in the pointerup handler below. time backs
      // the swipe-to-navigate check there too (SWIPE_MAX_DURATION), reusing
      // the exact same constants the main carousel's own touch-swipe uses
      // just above, for a consistent feel between the two.
      tapCandidate = { id: e.pointerId, x: e.clientX, y: e.clientY, time: Date.now(), moved: false, onImage: e.target === lbImage };
      if (scale > 1) dragLast = { x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      tapCandidate = null; // a 2nd finger joining means this is a pinch, not a tap
      const pts = Array.from(pointers.values());
      pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!lightboxOpen || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (tapCandidate && tapCandidate.id === e.pointerId) {
      const moved = Math.hypot(e.clientX - tapCandidate.x, e.clientY - tapCandidate.y);
      if (moved > TAP_MOVE_TOLERANCE) tapCandidate.moved = true;
    }

    if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchStartDist) {
        const factor = dist / pinchStartDist;
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;
        zoomAt(midX, midY, factor);
      }
      pinchStartDist = dist;
    } else if (pointers.size === 1 && dragLast && scale > 1) {
      tx += e.clientX - dragLast.x;
      ty += e.clientY - dragLast.y;
      dragLast = { x: e.clientX, y: e.clientY };
      applyTransform();
    }
  });

  function cleanupPointer(id) {
    pointers.delete(id);
    if (pointers.size < 2) pinchStartDist = null;
    if (pointers.size === 0) dragLast = null;
  }

  stage.addEventListener('pointerup', (e) => {
    const isCleanTap = pointers.size === 1 && pointers.has(e.pointerId) &&
      tapCandidate && tapCandidate.id === e.pointerId && !tapCandidate.moved;
    const wasOnImage = isCleanTap && tapCandidate.onImage;
    const wasOnBackdrop = isCleanTap && !tapCandidate.onImage;

    // Swipe-to-navigate between the two product photos, additive to the
    // existing pinch/pan/tap-to-zoom/backdrop-close gestures below, not a
    // replacement for any of them. Only considered when this same single
    // pointer actually moved (tapCandidate.moved -- so it's mutually
    // exclusive with isCleanTap above, never double-firing a zoom-toggle AND
    // a nav) and the image is at its base scale: once zoomed in, the
    // identical single-finger drag already pans the image instead (see
    // pointermove above), and swipe-to-navigate would fight that gesture for
    // the same input. Distance/duration thresholds and the dominant-axis
    // check mirror the main carousel's own touch-swipe (SWIPE_MIN_DISTANCE/
    // SWIPE_MAX_DURATION above) so the two feel consistent; goTo() already
    // wraps between the two slides and refreshes the lightbox's image + alt
    // text via updateLightboxImage() since lightboxOpen is true.
    if (pointers.size === 1 && pointers.has(e.pointerId) &&
        tapCandidate && tapCandidate.id === e.pointerId && tapCandidate.moved && scale === MIN_SCALE) {
      const dx = e.clientX - tapCandidate.x;
      const dy = e.clientY - tapCandidate.y;
      const elapsed = Date.now() - tapCandidate.time;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) >= SWIPE_MIN_DISTANCE && elapsed <= SWIPE_MAX_DURATION) {
        goTo(current + (dx < 0 ? 1 : -1));
      }
    }

    cleanupPointer(e.pointerId);
    tapCandidate = null;
    if (wasOnImage) toggleZoomAt(e.clientX, e.clientY);
    else if (wasOnBackdrop) closeLightbox();
  });
  stage.addEventListener('pointercancel', (e) => { cleanupPointer(e.pointerId); tapCandidate = null; });
  stage.addEventListener('pointerleave', (e) => { cleanupPointer(e.pointerId); tapCandidate = null; });
})();
