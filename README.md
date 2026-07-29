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

**CSP caveat:** ships `'unsafe-inline'` for both `script-src` and `style-src`.
Several pages (`checkout.html`, `account.html`, `product.html`, `index.html`,
`contact.html`) have genuine inline `<script>` blocks (not just external
`.js` files), plus one inline `style=""` attribute (`product.html`'s stock
bar) and an inline `onerror=` handler (`js/phone-input.js`'s flag `<img>`
fallback) — a strict policy without `'unsafe-inline'` (or per-block nonces/
hashes, which this static-output build has no mechanism to generate/keep in
sync) would silently break all of them. `element.style.xxx` JS assignments
(GSAP transforms/opacity, etc.) are *not* affected either way — CSP's
`style-src` only governs markup-level style sources (`<style>` tags, `<link
rel=stylesheet>`, inline `style=""` attributes), not runtime CSSOM
mutations. Every other directive (`script-src`'s domain allow-list,
`connect-src`, `frame-src`, `object-src 'none'`, `frame-ancestors 'none'`,
etc.) is fully enforced with no such carve-out.

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
