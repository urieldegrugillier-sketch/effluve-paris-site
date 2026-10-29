/* MONARK -- mobile-only carousel behavior for the product-page trust bar
   (product.html's #trust-bar, see css/style.css's TRUST BAR section).
   Desktop shows all 4 items at once (plain grid, this script's goTo() just
   becomes a harmless no-op transform there); at <=768px .trust-bar-track
   turns into a one-item-per-slide, swipeable, auto-advancing carousel.

   Swipe/transform mechanics are the same translateX(-n*100%) track +
   SWIPE_MIN_DISTANCE/SWIPE_MAX_DURATION/SWIPE_AXIS_DEADZONE thresholds as
   js/product-gallery.js's own photo carousel, reused rather than
   reinvented, for a consistent feel between the two. This file adds what
   that one doesn't need: autoplay (3.5s, looping), pausing while the user
   is actually touching the track and resuming after 5s of inactivity,
   skipping autoplay entirely under prefers-reduced-motion, and only running
   the timer while the bar is actually on screen (IntersectionObserver). */
(function () {
  const bar = document.getElementById('trust-bar');
  if (!bar) return;
  const viewport = bar.querySelector('.trust-bar-viewport');
  const track = document.getElementById('trust-bar-track');
  const items = track.querySelectorAll('.trust-bar-item');
  const dots = bar.querySelectorAll('.trust-bar-dots .carousel-dot');
  const count = items.length;
  let current = 0;

  const mobileQuery = window.matchMedia('(max-width: 768px)');
  const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Desktop: no transform at all (the grid shows every item already) --
  // only mobile actually slides the track.
  function render() {
    track.style.transform = mobileQuery.matches ? `translateX(-${current * 100}%)` : '';
    dots.forEach((dot, i) => dot.classList.toggle('active', i === current));
  }

  function goTo(index) {
    current = (index + count) % count;
    render();
  }

  dots.forEach((dot, i) => {
    dot.addEventListener('click', () => {
      goTo(i);
      pauseThenResume();
    });
  });

  // ---------------- Autoplay ----------------
  const AUTOPLAY_INTERVAL_MS = 3500;
  const RESUME_AFTER_MS = 5000;
  let autoplayTimer = null;
  let resumeTimer = null;
  let isVisible = false;

  function startAutoplay() {
    if (autoplayTimer || !mobileQuery.matches || reduceMotionQuery.matches || !isVisible) return;
    autoplayTimer = setInterval(() => goTo(current + 1), AUTOPLAY_INTERVAL_MS);
  }

  function stopAutoplay() {
    if (!autoplayTimer) return;
    clearInterval(autoplayTimer);
    autoplayTimer = null;
  }

  // Called on every touch/drag -- stops the timer immediately and arms a
  // fresh 5s-of-inactivity resume, rather than resuming on a fixed schedule
  // that could restart mid-gesture.
  function pauseThenResume() {
    stopAutoplay();
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(startAutoplay, RESUME_AFTER_MS);
  }

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        isVisible = entry.isIntersecting;
        if (isVisible) startAutoplay();
        else stopAutoplay();
      });
    }, { threshold: 0.3 });
    observer.observe(bar);
  } else {
    // No IntersectionObserver support -- fall back to "always visible"
    // rather than never autoplaying at all.
    isVisible = true;
    startAutoplay();
  }

  // Crossing the 768px breakpoint (rotating a tablet, resizing a desktop
  // window) re-renders with the right transform mode and starts/stops
  // autoplay to match -- same addEventListener('change', ...) pattern
  // js/account-page.js's own logoutMobileQuery already uses.
  mobileQuery.addEventListener('change', () => {
    stopAutoplay();
    render();
    if (mobileQuery.matches) startAutoplay();
  });

  // ---------------- Touch swipe (same thresholds as js/product-gallery.js) ----------------
  const SWIPE_MIN_DISTANCE = 40;
  const SWIPE_MAX_DURATION = 600;
  const SWIPE_AXIS_DEADZONE = 10;
  let touchStartX = 0, touchStartY = 0, touchStartTime = 0, swipeAxis = null;

  viewport.addEventListener('touchstart', (e) => {
    if (!mobileQuery.matches || e.touches.length !== 1) return;
    pauseThenResume();
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
    swipeAxis = null;
  }, { passive: true });

  viewport.addEventListener('touchmove', (e) => {
    if (!mobileQuery.matches || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    if (swipeAxis === null && (Math.abs(dx) > SWIPE_AXIS_DEADZONE || Math.abs(dy) > SWIPE_AXIS_DEADZONE)) {
      swipeAxis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (swipeAxis === 'x') e.preventDefault();
  }, { passive: false });

  viewport.addEventListener('touchend', (e) => {
    const axis = swipeAxis;
    swipeAxis = null;
    if (axis !== 'x') return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const elapsed = Date.now() - touchStartTime;
    if (Math.abs(dx) < SWIPE_MIN_DISTANCE || elapsed > SWIPE_MAX_DURATION) return;
    goTo(current + (dx < 0 ? 1 : -1));
  });

  render();
})();
