# MONARK — Eau de Parfum site

Static HTML/CSS/JS site. No framework, no bundler required for development.

## Project structure

```
index.html, product.html, checkout.html, account.html,     10 pages, project root
contact.html, faq.html, cgv.html, confidentialite.html,
mentions-legales.html, 404.html

css/
  style.css       Sitewide base styles, variables, type system -- every page
  shop.css        product.html only
  checkout.css    checkout.html + account.html (shared checkout accordion /
                  account-gate flow); also loaded by contact.html purely to
                  reuse its generic .checkout-field input styling
  contact.css     contact.html's own exclusive rules (honeypot, char
                  counter, the custom "Reason" dropdown)

js/               Mostly one file per concern, self-mounting/site-wide
                  (nav-menu, cart-widget, cookie-consent, promo-banner,
                  email-popup, footer-active-page, header-position-fix all
                  inject their own markup and run on every page); app.js is
                  index.html-only; account.js/places-autocomplete.js load
                  only on checkout.html + account.html; i18n.js is the
                  shared FR/EN translation engine + dictionary.

assets/           Copied into dist/ wholesale by scripts/build.js -- only put
                  things here the live site actually loads.
  icons/          Favicons (favicon.ico, favicon-16/32.png, apple-touch-icon.png)
  images/         Product/brand imagery
  frames/         Scroll-scrubbed .webp frames for index.html's canvas
                  animation (see js/app.js's framePath())

source-media/     NOT copied into dist/ -- raw/source material kept for
                  reference (e.g. the original video assets/frames/ was cut
                  from), git-tracked but never shipped to production.
  video/          SEG00_V03_Upscaled.mp4 -- source video for frames/'s .webp
                  sequence; nothing on the live site loads this file directly.

scripts/build.js  Production minifier (see "Production build" below)
dist/             Build output (minified css/js) -- generated, not source;
                  refresh it with `npm run build` after any css/js change
```

## Local development

Serve the project root with any static file server, e.g.:

```
python -m http.server 5500
```

Then open `http://localhost:5500/index.html`. Pages reference the plain,
unminified files in `css/` and `js/` directly — this is unaffected by the
build step below.

## Production build (minification)

A one-off Node build step minifies CSS/JS into `dist/` for deployment. It does
**not** change anything under `css/`/`js/`, and does not affect local dev.

```
npm install      # once
npm run build    # produces/refreshes dist/css and dist/js
```

Pointing an actual deployment at `dist/` (or copying its contents over
`css/`/`js/` at deploy time) is a separate step, left for whatever
hosting/deploy process is set up later.

## Before launch — placeholders to replace

- `https://effluve-paris.fr` — appears in every page's `<link rel="canonical">`,
  `index.html`/`product.html`'s Open Graph/Twitter tags, `robots.txt`, and
  `sitemap.xml`. Replace with the real production domain.

## Security headers

Configured via the `_headers` file at the project root (copied into `dist/`
by `scripts/build.js`, same as `robots.txt`/`sitemap.xml`) — Cloudflare
Workers Static Assets reads this file directly, no server-side config needed
beyond it being present in `assets.directory` (see `wrangler.jsonc`). The
`<meta name="referrer">` tag still exists on every page too, but the
`Referrer-Policy` header below is the real enforcement point.

| Header | Value | Why |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | No downside; always set this. |
| `X-Frame-Options` | `DENY` | Nothing on this site needs to be framed. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Matches the meta tag. |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Site is HTTPS-only via Cloudflare already. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Unused APIs, disabled. Deliberately does **not** restrict `payment` — Stripe's Payment Request Button (Apple Pay/Google Pay) depends on it. |
| `Content-Security-Policy` | see `_headers` | See caveat below. |

**CSP caveat:** ships `'unsafe-inline'` for `style-src` only (not `script-src`
— see below). One inline `style=""` attribute (`product.html`'s stock bar)
needs it; `element.style.xxx` JS assignments (GSAP transforms/opacity, etc.)
don't, either way — CSP's `style-src` only governs markup-level style
sources (`<style>` tags, `<link rel=stylesheet>`, inline `style=""`
attributes), not runtime CSSOM mutations.

`script-src` has no `'unsafe-inline'`: every page-specific block that used
to be a literal inline `<script>...</script>` now lives in its own file
under `js/` (e.g. `checkout.html`'s former ~1,400-line inline block is
`js/checkout-page.js`, `product.html`'s four blocks are
`js/product-gallery.js`/`product-page.js`/`product-countdown-note.js`/
`product-newsletter.js`, etc. — one file per former block, loaded via
`<script src>` at the exact same position so execution order/timing didn't
change). `js/phone-input.js`'s flag `<img>` fallback used to be a literal
`onerror=""` HTML attribute (also governed by `script-src`, since there's no
separate `script-src-attr` in this policy) — that's now a real
`addEventListener('error', ..., true)` on the widget's container instead.
The one exception is `product.html`'s JSON-LD `<script
type="application/ld+json">` block, which was never affected in the first
place: CSP's `script-src` only governs elements the HTML spec actually
treats as "script blocks", and a non-JS `type` like `application/ld+json`
means that element never is one, regardless of `'unsafe-inline'`.

Nonces weren't an option for closing this gap: nonce-based CSP needs a
fresh, unpredictable value minted per response, which requires server-side
logic on every request — impossible here since `_headers` is served
statically by Cloudflare Workers Static Assets with no per-request code
running in front of it. Per-block `sha256-` hashes were the other
alternative; externalizing was chosen instead since it also matches this
site's own existing "one file per concern" convention and doesn't leave a
hash to silently go stale (and start blocking the page) the next time
someone edits that inline code without recomputing it.

Every other directive (`script-src`'s domain allow-list, `connect-src`,
`frame-src`, `object-src 'none'`, `frame-ancestors 'none'`, etc.) is fully
enforced with no carve-out.

One gap to know about: `js/places-autocomplete.js` loads
`https://maps.googleapis.com` if a real Google Places API key is ever
configured there (it's currently a placeholder, so this path is dead code
today — see that file's own comment). If/when that key goes in,
`https://maps.googleapis.com` also needs adding to `_headers`' `script-src`
and `connect-src`, or Places autocomplete will silently stop working under
CSP.

## Forms — spam/abuse notes (no backend yet, so nothing is actually exploitable today)

None of `checkout.html`'s shipping form, the email-signup popup
(`js/email-popup.js`), or `contact.html`'s own form talk to a real backend
yet (see the "Mock success only"/honeypot comments at each submit handler) —
so there's no live endpoint to spam. Once any of them do:

- Add a honeypot field (a visually-hidden input real users never fill in;
  reject the submission if it's non-empty) to each.
- Rate-limit submissions per IP/session at whatever backend receives them.
- The email popup and checkout form should probably also get real server-side
  email format validation, not just the `type="email"`/`required` HTML
  attributes currently doing duty (see the comment at each submit handler).

## SEO note: checkout/account are `noindex` but still listed in `sitemap.xml`

`checkout.html` and `account.html` both carry `<meta name="robots"
content="noindex, nofollow">` (checkout.html: added when the page was built;
account.html: transactional/user-state-dependent in the same way, so it
carries the same tag from the start) while still appearing in `sitemap.xml`
(added in an earlier round, which listed all site pages). `noindex` wins in
practice — search engines that see both signals honor the meta tag — so this
isn't a functional problem, just a minor inconsistency worth knowing about.
Removing those entries from `sitemap.xml` would tidy it up but isn't
required.

`cart.html` was removed as a standalone page — the header's mini-cart preview
(see `js/cart-widget.js`) is now the site's only cart interface, so there's
no separate cart page left to carry these same notes.

## Graphify — codebase knowledge graph

This project has a persistent knowledge graph built with [graphify](https://github.com/safishamsi/graphify):
nodes for code symbols (functions, config), concepts, docs, and images; edges
for relationships between them (`calls`, `references`, `shares_data_with`,
`semantically_similar_to`, etc.), each tagged EXTRACTED/INFERRED/AMBIGUOUS
depending on how confidently it was derived from the source. The point is for
a future Claude Code session to query `graphify-out/graph.json` for "what
calls X" / "how does Y connect to Z" instead of re-reading and re-reasoning
over the whole codebase from scratch every time — worth it once a project is
large or long-running enough that repeated full-context re-reads start
costing real tokens.

It was run once on this project: **390 nodes, 524 edges, 56 communities**.
`graphify-out/` contains the queryable output (`graph.json`, plus `graph.html`
for an interactive graph you can open directly in a browser) plus a
human-readable `GRAPH_REPORT.md` audit (god nodes, surprising connections,
per-community cohesion scores, suggested follow-up questions). Re-run
`/graphify --update` after significant code changes to keep it current.

### Graph Clarifications

Answers to the questions graphify's own report flagged as worth checking,
verified against the actual code:

1. **`contact.html`'s custom "Reason" dropdown vs. `t()` in `js/i18n.js`.**
   Not a direct call. The dropdown's `<li>` options carry `data-i18n`
   attributes like every other translated string on the site, and get
   translated by `MonarkI18n.apply()`/`resolveKey()` — the same
   attribute-driven pass that runs over the whole page. `t()` is a *separate*
   helper on the same `MonarkI18n` object, used only for strings assembled at
   runtime with interpolated variables (e.g. `contact.html`'s own email-format
   error message). The dropdown never calls `t()` itself; graphify's AMBIGUOUS
   edge was a reasonable guess (same file, same i18n system) but the actual
   mechanism is `data-i18n` + `apply()`, not `t()`.

2. **Why `product.html` bridges "Site Pages & Legal/SEO" to "Cart & Promo
   Pricing", "Cart Preview Widget", and "Promo Countdown Timer".** Confirmed —
   `product.html` is the site's commercial hub: it hosts the Add to Cart
   button (`#add-to-cart-btn` and the mobile sticky-bar twin), the Stripe
   Payment Request Button express-buy path (Apple Pay/Google Pay/Link), the
   same shared `MonarkPromoCountdown` instance used by the banner and
   checkout, and a live Supabase-backed stock progress bar (`renderStock()`).
   A genuinely multi-role page, not a graph artifact.

3. **Why `addToCart()` bridges Cart to Site Pages and the Stripe flow.**
   Confirmed — `addToCart()` is called from the standard Add to Cart button,
   the sticky mobile bar's twin button, *and* from inside the Payment Request
   Button's `paymentmethod` handler (only when the cart is still empty, so the
   express-buy click itself represents "buy 1 unit"), which then goes on to
   complete payment in that same handler. The cross-community edges reflect a
   real shared code path, not accidental coupling.

4. **Should "Scroll-Driven Hero Canvas" (cohesion 0.06) be split?** Yes, but
   the reason is more specific than page content vs. commerce mixing — by the
   time this graph was built, `index.html`'s S1–S6 narrative sections and the
   Acquisition CTA had already landed in *other* communities. Community 0 is
   made up entirely of `js/app.js` internals: ~36 sibling functions handling
   canvas/frame rendering, scroll-position math, pyramid-tier reveal,
   header/logo repositioning, loader UI, and CTA fade thresholds, all as
   top-level functions in one script sharing module-scope state rather than
   calling each other much. That's what drags cohesion down — a single large
   scroll-engine file with many loosely-coupled visual-effect responsibilities,
   not a mix of unrelated concerns. Splitting `app.js` itself into smaller
   modules (e.g. frame/canvas rendering vs. scroll-position math vs.
   element-positioning helpers) would be the more targeted fix if this is ever
   revisited.
