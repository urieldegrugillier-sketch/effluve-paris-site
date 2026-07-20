/* MONARK — Eau de Parfum — scroll-driven site logic */

/* If the page loads/reloads with a URL hash (index.html#genesis, etc.), the
   browser's native "jump to #id" fires before Lenis/ScrollTrigger exist —
   landing on a raw, unscrubbed scroll position that the custom scroll system
   then has to reconcile with (misaligned frame index / section reveal state).
   script.js runs at the end of body, after the target elements have already
   parsed, so that native jump has typically already happened by the time this
   file executes — stripping the hash alone wouldn't undo it. Force back to
   the true top immediately, before anything else initializes; the original
   hash is captured and (deliberately) honored later, once the custom scroll
   system is actually ready — see the bottom of this file.

   scrollRestoration:'manual' additionally stops the browser from re-attempting
   its own fragment scroll later on (observed: Chromium can retry the native
   #id jump ~1s after our own scroll had already settled, landing on the raw
   element position and undoing our centered target — replaceState alone
   doesn't cancel that queued retry, this does). */
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}
const initialHash = window.location.hash;
if (initialHash) {
  history.replaceState(null, '', window.location.pathname + window.location.search);
}
window.scrollTo(0, 0);

gsap.registerPlugin(ScrollTrigger);

/* Confirmed via real touch-flick testing at 390x844: section 001's mobile
   scroll-scrubbed reveal (see SCRUB_HIDDEN_VARS below) visibly "zoomed in
   twice" in quick succession. Root cause, isolated by sampling its heading's
   transform/opacity across a simulated address-bar collapse (a completely
   normal mobile event mid-flick, not an edge case): at the SAME scrollY, the
   reveal was at ty:2.96/opacity:0.94 before the resize, then snapped
   BACKWARD to ty:5.86/opacity:0.88 right after -- because positionSections()
   (bound to 'resize', recalculating each mobile section's cascaded
   .style.top for the new viewport height) shifted the section a few px, and
   ScrollTrigger's own default auto-refresh-on-resize then re-measured this
   scrub's viewport-relative trigger (`start:'top bottom'`) against that new
   position, snapping the timeline's progress backward for the same scroll
   position. The user's continued scroll then replayed the remainder of the
   reveal forward again -- read as a double zoom. ignoreMobileResize below is
   GSAP's own documented flag for this exact gotcha, kept as defense in
   depth, but real-world testing (simulating the resize via CDP, with
   ScrollTrigger.isTouch confirmed truthy) showed ScrollTrigger's own refresh
   still firing regardless -- not reliable enough to depend on alone. The
   actual fix is at the source instead: see resizeIsGenuine further below,
   which stops positionSections() (and the other viewport-height-driven
   recalculations that depend on it) from moving anything during an
   address-bar-only resize in the first place, so even if ScrollTrigger does
   refresh, there's nothing shifted to snap against -- and autoRefreshEvents
   below additionally takes ScrollTrigger's own refresh out of the picture
   for ANY resize (leaving visibilitychange/DOMContentLoaded/load, its other
   defaults), replaced by our own explicit, gated ScrollTrigger.refresh()
   call alongside resizeIsGenuine's other consumers -- closing even the
   small remaining residual (a ScrollTrigger refresh still re-deriving
   'top bottom'/'bottom top' pixel bounds from the new viewport height even
   once nothing had actually moved) that ignoreMobileResize alone left. */
ScrollTrigger.config({ ignoreMobileResize: true, autoRefreshEvents: 'visibilitychange,DOMContentLoaded,load' });

const FRAME_COUNT = 120;
/* Was 2.0, which finished the frame animation (frame 120) at raw scroll progress
   0.5 and then froze the canvas for the entire second half of the scroll — a real
   "dead zone" where the stats/provenance/CTA sections kept advancing but the
   canvas didn't. 1.0 makes frame 120 land at progress 1.0 (document bottom, per
   ScrollTrigger's end:'bottom bottom'), so the animation runs the full scroll. */
const FRAME_SPEED = 1.0;
const isDesktop = window.matchMedia('(min-width: 769px)').matches;
// Separate, wider threshold for fixes explicitly scoped to "mobile/tablet" as a
// group (e.g. the dark overlay's reduced max opacity below) -- matches the
// max-width used for the equivalent CSS media queries elsewhere in this round,
// deliberately including 1024px-wide tablet landscape while excluding desktop.
const isMobileOrTablet = window.matchMedia('(max-width: 1024px)').matches;

const framePath = (i) => `assets/frames/frame_${String(i).padStart(4, '0')}.webp`;

/* ---------------- Lenis smooth scroll ---------------- */

const lenis = new Lenis({
  duration: 1.2,
  easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
  smoothWheel: true
});
lenis.on('scroll', ScrollTrigger.update);
gsap.ticker.add((time) => lenis.raf(time * 1000));
gsap.ticker.lagSmoothing(0);

/* ---------------- DOM refs ---------------- */

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const canvasWrap = document.getElementById('canvas-wrap');
const heroSection = document.getElementById('hero');
const scrollContainer = document.getElementById('scroll-container');
const darkOverlay = document.getElementById('dark-overlay');
const loader = document.getElementById('loader');
const loaderBar = document.getElementById('loader-bar');
const loaderPercent = document.getElementById('loader-percent');
const navLogo = document.querySelector('.nav-logo');
const siteHeader = document.querySelector('.site-header');

/* ---------------- Nav logo centering (px-based, not CSS left:50%) ----------------
   Real touch/momentum-scroll testing (CDP-synthesized fast flicks, throttled
   CPU, 390x844) exposed window.innerWidth itself flickering between ~390 and
   ~417 mid-scroll, with zero 'resize' events firing -- while
   document.documentElement.clientWidth and window.visualViewport.width stayed
   perfectly stable at 390 across the same scroll session. CSS left:50% on a
   position:fixed descendant resolves against that same volatile viewport
   metric, so the logo visibly jittered left/right in step with it. Computing
   the centering px from the stable clientWidth instead removes the jitter at
   its source rather than chasing it downstream. */
function positionNavLogo() {
  if (!navLogo) return;
  navLogo.style.left = (document.documentElement.clientWidth / 2) + 'px';
}
positionNavLogo();
window.addEventListener('resize', positionNavLogo);

/* ---------------- Header width (px-based, not CSS right:0) ----------------
   A second, distinct symptom of the same instability above: .site-header's
   own rendered width (via left:0;right:0) tracked window.innerWidth directly
   -- confirmed via the same real touch-flick testing, headerWidth flickered
   390<->417 in lockstep with innerWidth. .nav-links is flex-end-aligned
   inside this header, so Acquire and the cart icon visibly jumped ~27px
   left/right whenever it did. Driving the header's width from the same
   stable clientWidth metric fixes this at the source rather than patching
   each right-aligned child individually. */
function positionHeaderWidth() {
  if (!siteHeader) return;
  siteHeader.style.width = document.documentElement.clientWidth + 'px';
}
positionHeaderWidth();
window.addEventListener('resize', positionHeaderWidth);

/* ---------------- Canvas-wrap / dark-overlay width (px-based, not CSS inset:0) ----------------
   Same underlying bug, a third and fourth time: both are position:fixed with
   inset:0, whose auto-resolved width tracks window.innerWidth just like
   .site-header's old right:0 and .section-cta's old width:100% did. Confirmed
   via real touch-flick testing to be the cause of the canvas/background
   visibly shifting left-right during scroll -- updateHeroReveal() re-sets
   .canvas-wrap's clip-path 'circle(75% at 50% 50%)' on every single scroll
   event (not just once during the initial reveal), so a jittering width here
   means the wipe mask's own center point wobbles continuously for the entire
   scroll, not just at the start. #dark-overlay gets the same fix for
   consistency, since it's the same element shape sitting in the same stack. */
function positionCanvasWidth() {
  if (!canvasWrap) return;
  canvasWrap.style.width = document.documentElement.clientWidth + 'px';
}
positionCanvasWidth();
window.addEventListener('resize', positionCanvasWidth);

function positionDarkOverlayWidth() {
  if (!darkOverlay) return;
  darkOverlay.style.width = document.documentElement.clientWidth + 'px';
}
positionDarkOverlayWidth();
window.addEventListener('resize', positionDarkOverlayWidth);

/* ---------------- Progress <-> pixel mapping ----------------
   ScrollTrigger's "top top"/"bottom bottom" progress maps 0..1 to
   scrollY range [containerTop, containerTop + containerHeight - viewportHeight].
   Section placement, the pyramid pin, and per-section reveal triggers all
   need to agree with that same mapping (not a raw fraction of containerHeight),
   or content drifts out of sync with the frame/overlay timing. */

// Cached, not read live from window.innerHeight on every call: real touch-flick
// testing at 390x844 caught window.innerHeight itself flickering (901<->844)
// mid-scroll with zero 'resize' events firing -- the same no-resize-event
// volatility already found and fixed for window.innerWidth (see
// positionNavLogo/positionHeaderWidth/etc. above), just on the other axis this
// time. containerScrollRange() feeds every per-frame calculation in this file
// (updateCtaPin, updateDarkOverlay's containerP, the pyramid pin, section
// positioning), so a live read here meant a single stray frame could
// momentarily miscalculate any of them -- timing-random, so it could coincide
// with any point in the scroll, not just one specific section boundary.
// Caching it and only updating on a genuine 'resize' event makes every
// consumer immune, the same way the width-based fixes already are.
let cachedViewportHeight = window.innerHeight;

/* Confirmed via real touch-flick testing at 390x844 (simulating the address
   bar collapsing mid-scroll, a routine mobile occurrence): section 001's
   mobile scroll-scrubbed reveal visibly "zoomed in twice." Root cause --
   isolated by sampling its heading's transform/opacity across the exact
   moment the address bar collapses -- is this chain reacting to that resize:
   cachedViewportHeight updates -> positionSections() recasts every mobile
   section's cascaded .style.top against the new viewportHeight -> the
   section's on-screen position shifts by a few px -> GSAP's ScrollTrigger
   (its own default auto-refresh-on-resize, which ScrollTrigger.config's
   documented ignoreMobileResize flag did NOT suppress here even with
   isTouch confirmed truthy -- likely a heuristic mismatch in this exact
   synthetic-resize scenario, not reliable enough to depend on) re-measures
   the reveal's viewport-relative trigger against that new position,
   snapping the timeline's progress backward for the same scrollY. The
   user's continued scroll then replays the remainder of the reveal forward
   again -- read as a double zoom.
   An address-bar toggle never changes clientWidth (only height); a genuine
   layout-relevant resize (orientation change, real window resize) always
   does. Gating this whole chain on an actual width change removes the false
   trigger at its source, instead of depending on GSAP's own undocumented
   internal heuristic for the same distinction. */
// Computed once per 'resize' event (registered before the gated consumers
// below, so it always runs first) rather than re-derived separately by each
// consumer -- calling a "did width change" check independently in multiple
// listeners for the same event would have the first call's own bookkeeping
// mask the change from every listener after it.
let lastGenuineResizeWidth = document.documentElement.clientWidth;
let resizeIsGenuine = true;
window.addEventListener('resize', () => {
  const w = document.documentElement.clientWidth;
  resizeIsGenuine = w !== lastGenuineResizeWidth;
  lastGenuineResizeWidth = w;
});

window.addEventListener('resize', () => {
  if (!resizeIsGenuine) return;
  cachedViewportHeight = window.innerHeight;
});

function containerScrollRange() {
  const containerHeight = scrollContainer.offsetHeight;
  const viewportHeight = cachedViewportHeight;
  return { containerHeight, viewportHeight, scrollable: containerHeight - viewportHeight };
}

function progressToContainerPx(p) {
  const { scrollable } = containerScrollRange();
  return p * scrollable;
}

/* ---------------- Position sections along the 900vh timeline ---------------- */

const MOBILE_SECTION_GAP_PX = 32; // deliberate breathing room between stacked mobile sections' boxes -- see the cascade comment below

// The cascade below can push the last ordinary section (stats) later, in
// absolute container-px, than its raw data-leave% would suggest -- recorded
// here so recalcCtaFadeThresholds() (declared further down, near the CTA
// logic) can keep the CTA's fade-in from starting before that real position,
// instead of relying on a fixed percentage that assumes no cascade shift.
let mobileLastSectionBottomPx = null;

function positionSections() {
  const { viewportHeight } = containerScrollRange();
  const sections = document.querySelectorAll('.scroll-section:not(.section-cta)');

  if (!isDesktop) {
    // Mobile sections are plain height:auto stacked blocks, not fixed-height
    // panels -- and several adjacent sections share a zero (or near-zero)
    // data-enter/leave gap in the underlying percentage timeline (e.g. 002
    // leaves at the exact % that 003, the pyramid, enters). Positioning every
    // section purely from its own enter%/midpoint (as this used to, mirroring
    // desktop) silently assumes each section's real rendered height fits
    // within its own enter->leave pixel allotment -- true on desktop's
    // spacious 900vh timeline, but demonstrably false here: measured at
    // 390x844, the pyramid's 3 stacked tiers render ~1135px tall against an
    // ~928px allotment (34-56% of 600vh), and #genesis's own midpoint-centered
    // box (383px tall) extended past its own leave% into the pyramid's start.
    // That's a static, scroll-speed-independent box collision confirmed via
    // getBoundingClientRect() -- not a mistimed fade -- so both sections'
    // fully-opaque content could occupy the same screen space regardless of
    // how fast or slow the user scrolled. Cascading each section's top to
    // never start before the *previous* section's actual measured bottom
    // (plus a small gap) removes that collision unconditionally, independent
    // of any single section's real content height.
    let prevBottom = -Infinity;
    sections.forEach((section) => {
      const enter = parseFloat(section.dataset.enter) / 100;
      const naturalTop = progressToContainerPx(enter);
      const top = Math.max(naturalTop, prevBottom);
      section.style.top = top + 'px';
      section.style.transform = 'none';
      section.style.height = 'auto';
      section.style.opacity = section.style.opacity || '1';
      prevBottom = top + section.offsetHeight + MOBILE_SECTION_GAP_PX;
    });
    mobileLastSectionBottomPx = prevBottom;
    return;
  }

  sections.forEach((section) => {
    const enter = parseFloat(section.dataset.enter) / 100;
    const leave = parseFloat(section.dataset.leave) / 100;
    if (section.classList.contains('section-pyramid')) {
      // Desktop needs an exact 100vh box: it's what GSAP pins and what the
      // tier crossfade is choreographed against.
      section.style.top = progressToContainerPx(enter) + 'px';
      section.style.height = viewportHeight + 'px';
    } else {
      // "end"-anchored sections (the final persisted section) center on progress===1,
      // the true max scroll position, instead of the midpoint of their own enter/leave
      // range — so the content is exactly composed right where scrolling naturally stops.
      const anchorProgress = section.dataset.anchor === 'end' ? 1 : (enter + leave) / 2;
      const midPx = progressToContainerPx(anchorProgress) + viewportHeight / 2;
      section.style.top = midPx + 'px';
      section.style.transform = 'translateY(-50%)';
    }
    section.style.opacity = section.style.opacity || '1';
  });
}

positionSections();
window.addEventListener('resize', () => { if (resizeIsGenuine) positionSections(); });

/* ---------------- Frame preloader (two-phase) ---------------- */

const frames = new Array(FRAME_COUNT + 1);
let loadedCount = 0;

function updateLoaderUI() {
  const pct = Math.round((loadedCount / FRAME_COUNT) * 100);
  loaderBar.style.width = pct + '%';
  loaderPercent.textContent = pct + '%';
  if (loadedCount >= FRAME_COUNT) {
    gsap.delayedCall(0.3, () => loader.classList.add('loader-hidden'));
  }
}

function loadFrame(i) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      frames[i] = img;
      loadedCount++;
      updateLoaderUI();
      resolve();
    };
    img.onerror = () => { loadedCount++; updateLoaderUI(); resolve(); };
    img.src = framePath(i);
  });
}

async function preloadFrames() {
  const FIRST_BATCH = 12;
  const firstBatch = [];
  for (let i = 1; i <= FIRST_BATCH; i++) firstBatch.push(loadFrame(i));
  await Promise.all(firstBatch);
  drawFrame(1);

  const rest = [];
  for (let i = FIRST_BATCH + 1; i <= FRAME_COUNT; i++) rest.push(loadFrame(i));
  await Promise.all(rest);
}

/* ---------------- Canvas renderer (edge-to-edge cover mode) ---------------- */

let currentFrame = 1;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawFrame(currentFrame);
}

/* Source frames are landscape (1600x895, ~1.79:1). Plain "cover" (crop to fill
   both dimensions, Math.max) looks right on any viewport whose own aspect
   ratio is reasonably close to that -- laptop/desktop/tablet-landscape all
   are. But on a tall narrow phone (e.g. 375x667, ~0.56:1) cover's height-driven
   scale keeps only the *center ~31% of the source's width* on screen, cropping
   away nearly all the glass shards the shatter/reform animation is actually
   about -- the central "core" survives, but the storytelling doesn't. Since
   the canvas background already matches the page background (--bg-void),
   letterboxing is visually seamless -- there's no real cost to preferring a
   bit more of it over aggressive cropping. MAX_COVER_ZOOM_RATIO caps how much
   further "cover" is allowed to zoom in versus plain "contain" (fit the whole
   frame, no crop): past that ratio, the fit falls back toward contain instead,
   trading some extra top/bottom letterboxing for keeping the composition
   intact. 1.6 keeps ~62% of the source width visible even at the narrowest
   tested breakpoint (375px), while leaving normal desktop/laptop/tablet-
   landscape aspect ratios (already well under this ratio) completely
   unaffected -- verified via screenshot at all 6 target breakpoints. */
const MAX_COVER_ZOOM_RATIO = 1.6;

function drawFrame(index) {
  const img = frames[index];
  if (!img) return;
  // cw/ch come from the canvas's own buffer size (already stable -- only ever
  // set by resizeCanvas(), on load/real-resize), not a live window.innerWidth/
  // innerHeight read: this function runs on every single frame-index change
  // during scroll, and both of those measurably flicker mid-scroll with zero
  // 'resize' events firing (see cachedViewportHeight's comment above) -- a
  // live read here meant the drawn image's own scale/position could be
  // momentarily computed against a viewport size that didn't match the
  // canvas's actual pixel buffer for that one frame.
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.width / dpr, ch = canvas.height / dpr;
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const containScale = Math.min(cw / iw, ch / ih);
  const coverScale = Math.max(cw / iw, ch / ih);
  const scale = Math.min(coverScale, containScale * MAX_COVER_ZOOM_RATIO);
  const dw = iw * scale, dh = ih * scale;
  const dx = (cw - dw) / 2, dy = (ch - dh) / 2;
  ctx.fillStyle = '#0a0908';
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(img, dx, dy, dw, dh);
}

window.addEventListener('resize', () => { if (resizeIsGenuine) resizeCanvas(); });

/* ---------------- Hero circle-wipe reveal ---------------- */

const HERO_WIPE_START_P = 0.01, HERO_WIPE_DURATION_P = 0.06; // pageP fractions -- wipeProgress
                                                              // reaches 1 (reveal fully complete)
                                                              // at pageP = start + duration = 0.07.
                                                              // Referenced by recalcDarkOverlayEnter()
                                                              // below so the dark overlay can never
                                                              // start ramping in before this finishes.

function updateHeroReveal(p) {
  heroSection.style.opacity = Math.max(0, 1 - p * 15);
  heroSection.style.pointerEvents = p > 0.02 ? 'none' : 'auto';
  const wipeProgress = Math.min(1, Math.max(0, (p - HERO_WIPE_START_P) / HERO_WIPE_DURATION_P));
  const radius = wipeProgress * 75;
  canvasWrap.style.clipPath = `circle(${radius}% at 50% 50%)`;
}

/* ---------------- Dark overlay (stats section) ---------------- */

const DARK_OVERLAY_ENTER_EXTENDED = 0.05; // matches section 001's own data-enter -- the point
                                           // text first starts appearing, so the overlay is
                                           // fully dark by the time there's any text to read.
                                           // Correct on desktop, where S1's entrance ScrollTrigger
                                           // fires at this exact container-progress point too --
                                           // see recalcDarkOverlayEnter() below for why mobile needs
                                           // its own, differently-anchored value instead.

// Tightened from 0.04 in an earlier round -- a wide fade distance was half of
// "feels like it's chasing the text": even once synced to the right starting
// point, a slow multi-hundred-pixel ramp still reads as lagging. 0.02 (~half
// the scrollable-range distance) reaches full opacity noticeably faster while
// still being a smooth fade, not a hard cut. Shared with recalcDarkOverlayEnter
// below so its own wipe-completion clamp accounts for the ramp's full width,
// not just its end point.
const DARK_OVERLAY_FADE_RANGE = 0.02;

let darkOverlayEnterEffective = DARK_OVERLAY_ENTER_EXTENDED;

// Confirmed via real touch-flick testing at 390x844: section 001's own heading/body
// reached full opacity by scrollY~360, while the dark overlay didn't even start
// ramping in until scrollY~900 -- a ~540px window with fully-readable text and no
// legibility scrim behind it. Root cause: on mobile, setupSectionAnimation()'s
// scroll-scrubbed reveal (added when fixing the 002/003 overlap bug) triggers off
// `trigger: section, start: 'top bottom'` -- a VIEWPORT-RELATIVE position (fires
// once S1's own top edge reaches the viewport's bottom) -- not off container
// progress at all. DARK_OVERLAY_ENTER_EXTENDED, a raw container-progress fraction,
// only happens to match reality on desktop, where S1's entrance trigger is itself
// container-progress-based (`top+=X top`). On mobile the two are unrelated:
// because S1 sits near the very start of the container, its viewport-relative
// reveal point can fall a full viewport-height (or more) earlier in scroll terms
// than its raw data-enter% would suggest. Recalculating the overlay's own enter
// point from S1's actual measured position (mirroring the CTA threshold
// recalculation) keeps it locked to the same real trigger the text itself uses.
function recalcDarkOverlayEnter() {
  const { viewportHeight, scrollable } = containerScrollRange();
  if (scrollable <= 0) return;

  let enterP;
  if (isDesktop) {
    enterP = DARK_OVERLAY_ENTER_EXTENDED;
  } else {
    const firstSection = document.querySelector('.scroll-section:not(.section-cta)');
    if (!firstSection) return;
    const s1TopPx = parseFloat(firstSection.style.top) || 0;
    const revealStartPx = s1TopPx - viewportHeight; // matches the reveal ScrollTrigger's own 'top bottom' start
    // Deliberately NOT clamped to >=0: S1 sits close enough to the container's own
    // start that this point can legitimately fall *before* it (during the standalone
    // hero's own scroll range) -- confirmed at 390x844, revealStartPx computes to a
    // negative container-progress fraction there. Clamping it to 0 was tried first
    // and didn't fix the lag: it just moved the ramp to sit right at the container's
    // own start (p=0) regardless of how much earlier the real reveal happened,
    // leaving the same few-hundred-pixel gap. The negative value is handled
    // correctly below since updateDarkOverlay is now driven by lenis's own
    // continuous scroll event (see the comment there) instead of the master
    // ScrollTrigger's onUpdate, which -- like updateHeroReveal/frame-index below --
    // never fires at all while progress is clamped at the 0 boundary.
    enterP = revealStartPx / scrollable;
  }

  // Never start ramping in before the hero's own circle-wipe reveal has actually
  // finished (wipeProgress reaching 1, at pageP = HERO_WIPE_START_P +
  // HERO_WIPE_DURATION_P) -- confirmed via real touch-flick testing at 390x844
  // that without this, the overlay's own (correctly re-anchored) enter point
  // could still land before the wipe completes, showing dimmed text over a
  // canvas that hasn't finished opening up yet. Converting that same pageP
  // threshold into this function's own container-progress space and taking
  // whichever point is later keeps the two in the right order regardless of
  // which one the real content timing would otherwise put first.
  //
  // The clamp targets enterP + DARK_OVERLAY_FADE_RANGE (the point where the
  // ramp-UP *starts*, since updateDarkOverlay begins fading in at
  // enter - fadeRange), not enterP itself (where the ramp completes) --
  // clamping only enterP still let the fade-in visibly begin while the wipe
  // was mid-motion, just finishing at roughly the same time the wipe did.
  // Requiring the whole ramp to start only once the wipe is done keeps the
  // two as a clean, non-overlapping sequence: wipe finishes, *then* the
  // overlay begins.
  const maxScroll = document.documentElement.scrollHeight - cachedViewportHeight;
  const wipeCompletePageP = HERO_WIPE_START_P + HERO_WIPE_DURATION_P;
  const wipeCompleteScrollY = wipeCompletePageP * maxScroll;
  const wipeCompleteContainerP = (wipeCompleteScrollY - scrollContainer.offsetTop) / scrollable;
  enterP = Math.max(enterP, wipeCompleteContainerP + DARK_OVERLAY_FADE_RANGE);

  darkOverlayEnterEffective = enterP;
}
recalcDarkOverlayEnter();
window.addEventListener('resize', () => { if (resizeIsGenuine) recalcDarkOverlayEnter(); });

// Mobile/tablet (<=1024px): confirmed on a real phone that 0.9 (desktop's value)
// reads as too dark/crushing over the canvas visuals -- 0.6 keeps the same
// legibility purpose without flattening the underlying imagery as much. Desktop
// keeps 0.9 unchanged.
const DARK_OVERLAY_MAX_OPACITY = isMobileOrTablet ? 0.6 : 0.9;

function updateDarkOverlay(p) {
  const fadeRange = DARK_OVERLAY_FADE_RANGE;
  // Extended across ALL text sections (001-005), not just stats -- previously it only
  // appeared late (fading in around 005), leaving 001-003 with no legibility scrim and
  // an abrupt appearance around 004. Applies at every width (mobile included) -- an
  // earlier version gated this to isTabletUp (>=768px) only, but the extended range is
  // now wanted everywhere.
  const enter = darkOverlayEnterEffective;
  // leave matches the same recalculated stats-actually-ended point CTA's own fade
  // uses (see recalcMobileCtaThresholds below) rather than a hardcoded 0.82 --
  // on mobile the stats section can be cascaded later than its raw data-leave%,
  // and this used to fade the dark overlay out before stats had actually scrolled
  // away, same bug class as the CTA-fading-in-too-early one described there.
  const leave = ctaFadeEnterEffective;
  let opacity = 0;
  // Scaled by DARK_OVERLAY_MAX_OPACITY throughout (not just the plateau) so the
  // ramp-in/out target the same reduced mobile ceiling instead of overshooting
  // to 1.0 and snapping down -- that snap was harmless at the old 0.9 (a
  // sub-pixel-wide overshoot, imperceptible) but would have been a visible
  // discontinuity at the new, lower mobile value.
  if (p >= enter - fadeRange && p <= enter) opacity = DARK_OVERLAY_MAX_OPACITY * (p - (enter - fadeRange)) / fadeRange;
  else if (p > enter && p < leave) opacity = DARK_OVERLAY_MAX_OPACITY;
  else if (p >= leave && p <= leave + fadeRange) opacity = DARK_OVERLAY_MAX_OPACITY * (1 - (p - leave) / fadeRange);
  darkOverlay.style.opacity = opacity;
}

/* ---------------- CTA section (fixed to the viewport, not scroll-positioned) ----------------
   Absolutely positioning this section within the 900vh scroll-container and centering it
   with translateY(-50%) made it visibly slide up into place as the user scrolled — a real
   scroll-positioning artifact, not an animation bug. Instead it's fixed to the viewport
   bottom in CSS (opacity:0, pointer-events:none) and only toggled visible/interactive here
   once scroll progress reaches its entry point; positionSections() no longer touches it. */

const ctaSection = document.querySelector('.section-cta');

/* ---------------- CTA width (px-based, not CSS width:100%) ----------------
   The same window.innerWidth-driven instability fixed for .site-header's own
   width (see positionHeaderWidth() above) applies here too -- width:100% on a
   position:fixed element resolves against that same volatile metric. Confirmed
   via real touch-flick testing at 390x844: a brief horizontal shift/glitch
   right as the CTA appears at the end of scroll, on top of a one-time jump at
   the position:fixed -> position:relative unpin transition (a normal-flow
   element's width is no longer subject to that volatility at all, so if the
   volatile value happened to be off from the true one right at that instant,
   the switch itself was visibly abrupt). Driving it from the same stable
   clientWidth metric fixes both. */
function positionCtaWidth() {
  if (!ctaSection) return;
  ctaSection.style.width = document.documentElement.clientWidth + 'px';
}
positionCtaWidth();
window.addEventListener('resize', positionCtaWidth);

const CTA_FADE_ENTER = 0.82, CTA_FADE_VISIBLE = 0.86; // enter matches section-stats data-leave exactly (zero gap)
                                                       // — also referenced by updateCtaPin() below, as the anchor
                                                       // for when the CTA un-pins.

// On mobile, positionSections()'s cascade (see MOBILE_SECTION_GAP_PX above) can push
// stats' actual bottom edge later, in absolute container-px, than 82% of the scroll
// range would suggest -- confirmed via real touch-flick testing at 390x844: stats'
// measured bottom landed at container-progress ~0.839, but CTA_FADE_ENTER's hardcoded
// 0.82 started fading the CTA in (and pointer-events:auto) 45px before stats had
// actually scrolled away -- a real, confirmed overlap, not a test artifact. Recalculating
// the effective threshold from stats' own measured position after every cascade removes
// that assumption entirely; the raw 0.82/0.86 are kept as floors so this can only ever
// push the thresholds LATER (matching the original design intent when nothing overflows
// its allotment), never earlier. Desktop never cascades (mobileLastSectionBottomPx stays
// null there), so it always falls back to the original constants unchanged.
let ctaFadeEnterEffective = CTA_FADE_ENTER;
let ctaFadeVisibleEffective = CTA_FADE_VISIBLE;

// How much of the container's own scroll range recalcCtaFadeThresholds() is
// allowed to push ctaFadeEnterEffective toward, at most. Confirmed via real
// testing at 320x568 (a real, common small-phone width): without this cap,
// heavily-wrapped copy on a narrow/short viewport can push stats' cascaded
// bottom edge PAST the container's entire scrollable range, so
// Math.min(1, enterPx/scrollable) clamped both thresholds to exactly 1 --
// collapsing updateCtaVisibility's (p - enter)/(visible - enter) division to
// 0/0 (NaN), which silently left the CTA at opacity 0 forever. It never
// appeared at all. Capping below 1 guarantees the fade window (and some
// dwell time before the true scroll end) always exists, even in that extreme
// case -- at the cost of a small, unavoidable overlap risk in that same
// extreme case, which is the lesser problem of the two.
const CTA_FADE_ENTER_MAX = 0.94;

function recalcCtaFadeThresholds() {
  if (isDesktop || mobileLastSectionBottomPx == null) {
    ctaFadeEnterEffective = CTA_FADE_ENTER;
    ctaFadeVisibleEffective = CTA_FADE_VISIBLE;
    return;
  }
  const { scrollable } = containerScrollRange();
  if (scrollable <= 0) return;
  const naturalEnterPx = CTA_FADE_ENTER * scrollable;
  const enterPx = Math.max(naturalEnterPx, mobileLastSectionBottomPx);
  ctaFadeEnterEffective = Math.min(CTA_FADE_ENTER_MAX, enterPx / scrollable);
  ctaFadeVisibleEffective = Math.min(1, ctaFadeEnterEffective + (CTA_FADE_VISIBLE - CTA_FADE_ENTER));
}
recalcCtaFadeThresholds();
window.addEventListener('resize', () => { if (resizeIsGenuine) recalcCtaFadeThresholds(); });

// Registered last in this chain so cachedViewportHeight/positionSections/
// recalcDarkOverlayEnter/recalcCtaFadeThresholds above have all already
// applied their new positions for this same resize event before
// ScrollTrigger re-measures against them -- see autoRefreshEvents' comment
// near the top of this file for why this replaces GSAP's own default
// refresh-on-resize instead of just running alongside it.
window.addEventListener('resize', () => { if (resizeIsGenuine) ScrollTrigger.refresh(); });

function updateCtaVisibility(p) {
  if (!ctaSection) return;
  const opacity = Math.max(0, Math.min(1, (p - ctaFadeEnterEffective) / (ctaFadeVisibleEffective - ctaFadeEnterEffective)));
  ctaSection.style.opacity = opacity;
  ctaSection.style.pointerEvents = p >= ctaFadeEnterEffective ? 'auto' : 'none';
}

/* ---------------- CTA un-pin, anchored to the CTA's own fade-in completion ----------------
   .section-cta is position:fixed for the entire main scroll range specifically
   so it doesn't visibly slide into place (see the comment on updateCtaVisibility
   above) — but "fixed" also means it permanently covers the full viewport for
   as long as it's opaque, at ANY opacity. Fading its opacity down (tried
   previously) just reveals whatever else is fixed behind it — the still-opaque,
   always-rendering canvas — not the footer, since the footer is a normal-flow
   element far shorter than the viewport. Opacity was never the right tool here.

   An earlier version anchored the un-pin threshold to containerBottomY (the
   900vh scroll-container's own bottom edge, i.e. container progress p===1) —
   technically jump-free, but that left the entire remaining ~14% of the
   container's own scroll range (from CTA_FADE_VISIBLE at p=0.86 up to p=1)
   sitting between "the CTA looks fully done" and "anything happens next",
   regardless of how small the trailing spacer/margin-shift was made. That
   14%-of-900vh stretch was the real source of the long wait, not the spacer.

   Anchoring to CTA_FADE_VISIBLE's own scrollY instead (plus a short fixed
   CTA_GAP_VH buffer) fixes that: the container's own p===1 point, and
   everything else keyed to container progress (frame animation, dark
   overlay, pyramid pin, stats reveals), is untouched — only the un-pin
   trigger is decoupled from it and moved earlier.

   The only jump-free instant to switch position:fixed -> position:relative
   is when the in-flow CTA's own top edge would land exactly at the current
   viewport top (matching what the fixed version was already showing 1:1).
   That top edge is fixed by the document's own structure at scrollContainer's
   bottom edge (containerBottomY) — nothing after the container can start any
   earlier in normal flow. To make the swap land at the much earlier
   fade-completion-based stitchY instead while staying jump-free, the
   swapped-in CTA gets `margin-top: -shiftPx`, where
   shiftPx = containerBottomY - stitchY: this pulls its rendered box up from
   containerBottomY to exactly the target scrollY. A negative margin-top also
   pulls everything after it (the footer) up by the same amount in normal
   flow — so the footer still sits immediately below the CTA's bottom with no
   dead gap... up to a point. #scroll-container is itself a normal-flow block
   (position:relative; height:900vh, needed as the coordinate space for its
   absolutely-positioned children and the pin/frame math) — it reserves that
   full height in document flow independently of CTA/footer, no matter how
   far they get shifted up. If the shift pulls the footer's own bottom edge
   earlier than containerBottomY, the page's total scroll height stays pinned
   to containerBottomY anyway (the container's reserved box wins the max()),
   reopening a dead-scroll gap *after* the footer — the exact bug this whole
   mechanism exists to avoid. noDeadZoneFloor below is the earliest stitchY
   that still lands the footer's bottom exactly on containerBottomY (zero
   dead space); the desired fade-anchored point is clamped to never go
   earlier than that. No opacity, no transparency. Re-pins (swaps back,
   clears the margin) automatically on scrolling back up past the same
   threshold. */
const ctaSpacer = document.getElementById('cta-spacer');
const siteFooter = document.querySelector('footer.shop-footer');
const CTA_GAP_VH = 0.20; // 20vh: a deliberate pause after the fade-in completes, not a snap —
                         // short enough that the footer still feels like "the next thing"
let ctaUnpinned = false;

function updateCtaPin() {
  if (!ctaSection || !ctaSpacer) return;
  const { viewportHeight, scrollable } = containerScrollRange();
  const containerBottomY = scrollContainer.offsetTop + scrollContainer.offsetHeight;
  const fadeCompleteY = scrollContainer.offsetTop + ctaFadeVisibleEffective * scrollable;
  const gapPx = CTA_GAP_VH * viewportHeight;
  const desiredStitchY = fadeCompleteY + gapPx;
  const footerHeight = siteFooter ? siteFooter.offsetHeight : 0;
  const noDeadZoneFloor = containerBottomY - viewportHeight - footerHeight;
  const stitchY = Math.max(desiredStitchY, noDeadZoneFloor);
  const shiftPx = containerBottomY - stitchY;
  const shouldUnpin = window.scrollY >= stitchY;

  if (shouldUnpin && !ctaUnpinned) {
    ctaUnpinned = true;
    ctaSection.classList.add('cta-unpinned');
    ctaSection.style.marginTop = `-${shiftPx}px`;
    ctaSpacer.replaceWith(ctaSection);
  } else if (!shouldUnpin && ctaUnpinned) {
    ctaUnpinned = false;
    ctaSection.classList.remove('cta-unpinned');
    ctaSection.style.marginTop = '';
    ctaSection.replaceWith(ctaSpacer);
    scrollContainer.appendChild(ctaSection); // position:fixed again, so exact spot inside doesn't matter
  } else if (shouldUnpin && ctaUnpinned) {
    // Already unpinned -- keep reapplying the (freshly recomputed, from live
    // values above) margin every call, not just at the transition instant.
    // Mobile browsers commonly change window.innerHeight *during* a scroll
    // session (the address bar collapsing/expanding as the user scrolls) --
    // without this, a margin computed once at the transition goes stale the
    // moment that happens, visibly misaligning the CTA/footer handoff for the
    // rest of the scroll session even though the underlying math is correct.
    ctaSection.style.marginTop = `-${shiftPx}px`;
  }
}
updateCtaPin(); // set the correct initial state before the first scroll event fires

/* ---------------- Pyramid tier crossfade (pinned pin, desktop only) ---------------- */

const pyramidSection = document.querySelector('.section-pyramid');
const tiers = pyramidSection ? Array.from(pyramidSection.querySelectorAll('.pyramid-tier')) : [];
const tierThresholds = [0.318, 0.682];
let activeTierIndex = -1;

const PYRAMID_HEADER_LEAD = 0.025; // scroll distance reserved for the kicker+heading to lead before any tier appears

function updatePyramidTiers(p) {
  if (!pyramidSection) return;
  const enter = 0.34, leave = 0.56; // matches section-pyramid data-enter/leave (shifted -6pts)
  const tiersEnter = enter + PYRAMID_HEADER_LEAD;

  if (p < tiersEnter || p > leave) {
    if (activeTierIndex !== -1) {
      activeTierIndex = -1;
      tiers.forEach((tier) => gsap.to(tier, { opacity: 0, duration: 0.3, ease: 'power2.out' }));
    }
    return;
  }

  const local = (p - tiersEnter) / (leave - tiersEnter);
  let idx = 0;
  if (local >= tierThresholds[1]) idx = 2;
  else if (local >= tierThresholds[0]) idx = 1;
  if (idx !== activeTierIndex) {
    activeTierIndex = idx;
    tiers.forEach((tier, i) => {
      if (i === idx) {
        gsap.fromTo(tier, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'power2.out' });
        gsap.fromTo(tier.querySelectorAll('.section-label, .tier-heading, .section-body'),
          { y: 30, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.7, stagger: 0.1, ease: 'power3.out', delay: 0.05 });
      } else {
        gsap.to(tier, { opacity: 0, duration: 0.4, ease: 'power2.out' });
      }
    });
  }
}

/* ---------------- Master scroll-bound ScrollTrigger ---------------- */

ScrollTrigger.create({
  trigger: scrollContainer,
  start: 'top top',
  end: 'bottom bottom',
  scrub: true,
  onUpdate: (self) => {
    const p = self.progress;
    updateCtaVisibility(p);
    if (isDesktop) updatePyramidTiers(p);
  }
});

/* GSAP skips a ScrollTrigger's own onUpdate while its self.progress stays
   clamped at 0/1 (nothing "changed" from its perspective) — so frame-index and
   hero-reveal logic living inside the ScrollTrigger above never ran for the
   entire first viewport-height of scroll (the standalone hero occupies that
   screen in normal flow before scrollContainer's own "top top" is even
   reached), even though updateHeroReveal(0) / frame 1 would have been correct
   right at scrollY 0 too. Hooking these two directly to Lenis's own scroll
   event sidesteps that gating entirely, so both start moving the instant the
   user scrolls from the very top of the page. pageP reaches 1 at the same
   scrollY (maxScroll/document bottom) that the container-relative progress
   above does, so frame 120 still lands at the true bottom as intended.

   updateDarkOverlay is hooked here too, for the same reason: on mobile,
   darkOverlayEnterEffective can legitimately be negative (S1's real reveal
   point falls before the container's own start -- see recalcDarkOverlayEnter
   above), and the master ScrollTrigger above never calls back while its own
   progress is still clamped at 0, which is exactly the range that matters
   here. Computing container-relative progress directly from raw scrollY
   (unclamped, so it can go negative too) instead of relying on the master
   ScrollTrigger's own supplied progress sidesteps that gating entirely. */
lenis.on('scroll', () => {
  const maxScroll = document.documentElement.scrollHeight - cachedViewportHeight;
  const pageP = maxScroll > 0 ? Math.min(1, Math.max(0, window.scrollY / maxScroll)) : 0;

  const accelerated = Math.min(pageP * FRAME_SPEED, 1);
  const index = Math.max(1, Math.min(Math.floor(accelerated * FRAME_COUNT) + 1, FRAME_COUNT));
  if (index !== currentFrame) {
    currentFrame = index;
    requestAnimationFrame(() => drawFrame(currentFrame));
  }

  updateHeroReveal(pageP);
  updateCtaPin();

  const { scrollable } = containerScrollRange();
  const containerP = scrollable > 0 ? (window.scrollY - scrollContainer.offsetTop) / scrollable : 0;
  updateDarkOverlay(containerP);
});

/* ---------------- Pyramid pin (desktop only) ---------------- */

if (isDesktop && pyramidSection) {
  ScrollTrigger.create({
    trigger: scrollContainer,
    start: () => 'top+=' + progressToContainerPx(0.34) + ' top',
    end: () => 'top+=' + progressToContainerPx(0.56) + ' top',
    pin: pyramidSection,
    pinSpacing: false,
    scrub: true
  });
}

/* ---------------- Section entrance choreography ---------------- */

/* Mobile-only: the "hidden" state per animation type, used to build a
   scroll-scrubbed reveal/hide instead of a fixed-duration discrete tween --
   see the mobile branch inside setupSectionAnimation() below for why. */
const SCRUB_HIDDEN_VARS = {
  'fade-up': { y: 50, opacity: 0 },
  'slide-left': { x: -80, opacity: 0 },
  'slide-right': { x: 80, opacity: 0 },
  'scale-up': { scale: 0.85, opacity: 0 },
  'rotate-in': { y: 40, rotation: 3, opacity: 0 },
  'stagger-up': { y: 60, opacity: 0 },
  'clip-reveal': { clipPath: 'inset(100% 0 0 0)', opacity: 0 }
};
const SCRUB_STAGGER = { 'fade-up': 0.12, 'slide-left': 0.14, 'slide-right': 0.14, 'scale-up': 0.12, 'rotate-in': 0.1, 'stagger-up': 0.15, 'clip-reveal': 0.15 };
const SCRUB_EASE_OUT = { 'fade-up': 'power3.out', 'slide-left': 'power3.out', 'slide-right': 'power3.out', 'scale-up': 'power2.out', 'rotate-in': 'power3.out', 'stagger-up': 'power3.out', 'clip-reveal': 'power4.inOut' };
const SCRUB_EASE_IN = { 'fade-up': 'power3.in', 'slide-left': 'power3.in', 'slide-right': 'power3.in', 'scale-up': 'power2.in', 'rotate-in': 'power3.in', 'stagger-up': 'power3.in', 'clip-reveal': 'power4.inOut' };

function setupSectionAnimation(section) {
  const type = section.dataset.animation;
  if (type === 'none') return;
  const persist = section.dataset.persist === 'true';
  const enter = parseFloat(section.dataset.enter);
  const leave = parseFloat(section.dataset.leave);
  const isPyramid = section.classList.contains('section-pyramid');
  const isCta = section.classList.contains('section-cta');
  const isFadeIn = type === 'fade-in';

  const children = isPyramid
    ? section.querySelectorAll('.pyramid-kicker, .pyramid-heading')
    : isCta
      ? section.querySelectorAll('.cta-image-col, .cta-divider, .cta-text-col')
      : section.querySelectorAll('.section-label, .section-heading, .section-body, .section-note, .cta-button, .stat');

  if (!children.length) return;

  // Real touch-flick CDP testing at 390x844 caught two distinct mobile bugs
  // here, both now fixed:
  //
  // 1) The PRIMARY one, a static layout collision, not a timing race:
  // positionSections() used to center every ordinary section at the midpoint
  // of its own enter/leave % range, assuming its rendered height fit within
  // its own enter->leave pixel allotment. Measured directly via
  // getBoundingClientRect(): #genesis's centered box (383px tall) rendered at
  // container-px [1412, 1795], while the pyramid's box (top-anchored at its
  // own enter%, 1135px tall from its 3 stacked tiers) rendered at [1435,
  // 2570] -- a ~360px overlap that existed at ANY scroll speed, including a
  // dead-slow deliberate scroll, because it's pure box position, not opacity.
  // That's fixed in positionSections() by cascading each mobile section's top
  // to never start before the previous section's actual measured bottom.
  //
  // 2) A secondary, genuine timing race on top of that: section 002's own
  // leave% equals section 003's own enter% (zero gap), and a fixed-duration
  // reverse-tween triggered by a discrete onLeave event can be outpaced by a
  // fast enough real flick regardless of how short its duration is -- caught
  // live at scrollY 1798-2285, #genesis's heading sitting at opacity 0.99->0.60
  // while the pyramid's tier-top content (no fade-in of its own; plain CSS
  // opacity:1 on mobile) was already fully on-screen. Scroll-scrubbing below
  // removes that race too: opacity/transform become a pure function of scroll
  // position (like updateDarkOverlay/updateCtaVisibility already are), so the
  // hide phase is always exactly complete by the time the section is
  // scrolled past, regardless of scroll speed.
  //
  // The trigger is the section itself (not scrollContainer + %-derived pixel
  // math) specifically because positionSections() can now push a mobile
  // section's actual top later than its raw enter% would suggest (the
  // cascade above) -- self-referencing the section's own live rendered
  // position stays correct regardless.
  //
  // Desktop's 900vh range has neither problem (sections comfortably fit their
  // allotment, and a fixed short tween is trivially faster than that much
  // larger per-pixel scroll distance), so its existing discrete
  // play()/reverse() behavior below is left untouched.
  const scrubVars = SCRUB_HIDDEN_VARS[type];
  if (!isDesktop && !persist && scrubVars) {
    const stagger = SCRUB_STAGGER[type];
    const tl = gsap.timeline({ paused: true });
    // Reveal and hide each get 1 "unit" of the timeline, with a long dwell in
    // between at full opacity -- since scrub maps scroll-distance-in-range
    // proportionally to timeline duration (not wall-clock time), this keeps
    // reveal/hide each a brief ~1/9th of the section's own on-screen scroll
    // range, no matter how tall that range is, while guaranteeing both
    // complete before the boundary rather than merely finishing "fast enough
    // in most cases".
    tl.from(children, { ...scrubVars, stagger, duration: 1, ease: SCRUB_EASE_OUT[type] });
    tl.to({}, { duration: 7 });
    tl.to(children, { ...scrubVars, stagger, duration: 1, ease: SCRUB_EASE_IN[type] });
    ScrollTrigger.create({
      trigger: section,
      start: 'top bottom',
      end: 'bottom top',
      scrub: true,
      animation: tl
    });
    return;
  }

  const tl = gsap.timeline({ paused: true });
  switch (type) {
    case 'fade-up':
      tl.from(children, { y: 50, opacity: 0, stagger: 0.12, duration: 0.9, ease: 'power3.out' });
      break;
    case 'slide-left':
      tl.from(children, { x: -80, opacity: 0, stagger: 0.14, duration: 0.9, ease: 'power3.out' });
      break;
    case 'slide-right':
      tl.from(children, { x: 80, opacity: 0, stagger: 0.14, duration: 0.9, ease: 'power3.out' });
      break;
    case 'scale-up':
      tl.from(children, { scale: 0.85, opacity: 0, stagger: 0.12, duration: 1.0, ease: 'power2.out' });
      break;
    case 'rotate-in':
      tl.from(children, { y: 40, rotation: 3, opacity: 0, stagger: 0.1, duration: 0.9, ease: 'power3.out' });
      break;
    case 'stagger-up':
      tl.from(children, { y: 60, opacity: 0, stagger: 0.15, duration: 0.8, ease: 'power3.out' });
      break;
    case 'clip-reveal':
      tl.from(children, { clipPath: 'inset(100% 0 0 0)', opacity: 0, stagger: 0.15, duration: 1.2, ease: 'power4.inOut' });
      break;
    case 'fade-in':
      tl.to(children, { opacity: 1, visibility: 'visible', stagger: 0.12, duration: 1.2, ease: 'power2.out', clearProps: 'transform', immediateRender: false });
      break;
  }

  let st;
  st = ScrollTrigger.create({
    trigger: scrollContainer,
    start: () => 'top+=' + progressToContainerPx(enter / 100) + ' top',
    end: () => 'top+=' + progressToContainerPx(leave / 100) + ' top',
    onEnter: () => {
      if (isFadeIn) gsap.set(children, { opacity: 0, visibility: 'hidden', immediateRender: true });
      tl.play();
      if (persist) st.kill(); // never let a persisted section be reversed again, even by boundary/rubber-band jitter
    },
    onEnterBack: () => tl.play(),
    onLeave: () => { if (!persist) tl.reverse(); },
    onLeaveBack: () => { if (!persist) tl.reverse(); }
  });
}

document.querySelectorAll('.scroll-section[data-animation]').forEach(setupSectionAnimation);

/* ---------------- Counter animations ---------------- */

document.querySelectorAll('.stat-number').forEach((el) => {
  const target = parseFloat(el.dataset.value);
  const decimals = parseInt(el.dataset.decimals || '0', 10);
  gsap.from(el, {
    textContent: 0,
    duration: 2,
    ease: 'power1.out',
    snap: { textContent: decimals === 0 ? 1 : 0.01 },
    scrollTrigger: {
      trigger: el.closest('.scroll-section'),
      start: 'top 70%',
      toggleActions: 'play none none reverse'
    }
  });
});

/* ---------------- Nav smooth-scroll ----------------
   Sections are absolutely (or, for the CTA, fixed-) positioned inside the 900vh
   scroll-container rather than laid out normally, so scrolling to a target
   element's own rendered position is unreliable — .section-content sections sit
   translateY(-50%) off their "top", and the fixed CTA section reports a constant
   viewport-relative rect no matter the scroll depth. Instead, jump straight to the
   scrollY that corresponds to the target's own data-enter progress. */

const NAV_ENTER_MARGIN = 1.5; // land safely past data-enter (not exactly on it) so the entrance
                               // ScrollTrigger's onEnter reliably fires — landing dead-on a raw
                               // data-enter% can settle at a sub-pixel offset that never registers
                               // as "crossing" the trigger, leaving the section stuck unrevealed
const CTA_NAV_ENTER_MARGIN = 4; // the CTA section also has its own continuous opacity fade spanning
                                 // data-enter to data-enter+4 (see updateCtaVisibility) — land past
                                 // the whole fade, not just the GSAP children's trigger point

function scrollToSection(target) {
  if (!target || !target.dataset.enter) return false;
  const enter = parseFloat(target.dataset.enter);
  const leave = parseFloat(target.dataset.leave);
  let enterProgress;
  if (target.classList.contains('section-cta')) {
    enterProgress = (enter + CTA_NAV_ENTER_MARGIN) / 100;
  } else if (target.classList.contains('section-pyramid')) {
    // top-anchored (fills the viewport starting at its own "top", no centering) — a small
    // margin past enter is enough to reliably cross the entrance/pin trigger.
    enterProgress = (enter + NAV_ENTER_MARGIN) / 100;
  } else {
    // .section-content sections are centered via translateY(-50%) around the midpoint of
    // their own enter/leave range (see positionSections()), not anchored at "enter" — landing
    // near raw enter leaves the section mostly below the fold, cropping its bottom. Landing at
    // that same midpoint is both comfortably past the entrance trigger and correctly centered.
    enterProgress = (enter + leave) / 2 / 100;
  }
  const containerTop = scrollContainer.getBoundingClientRect().top + window.scrollY;
  const targetY = containerTop + progressToContainerPx(enterProgress);
  lenis.scrollTo(targetY, { duration: 1.6 });
  return true;
}

document.querySelectorAll('[data-nav-link]').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    scrollToSection(document.querySelector(link.getAttribute('href')));
  });
});

/* ---------------- Init ---------------- */

resizeCanvas();
preloadFrames();

/* Honor a hash that was present on load (captured and stripped from the URL
   bar at the very top of this file) now that Lenis/ScrollTrigger are fully
   set up, rather than silently discarding the user's deep-link intent. #hero
   has no data-enter (it's the standalone hero, not a scroll-container
   section) — scrollToSection() no-ops for it, which is correct: the forced
   scrollTo(0,0) above already left the user exactly there. */
if (initialHash) {
  scrollToSection(document.querySelector(initialHash));
}
