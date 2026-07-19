# MONARK — Eau de Parfum site

Static HTML/CSS/JS site. No framework, no bundler required for development.

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

- `https://YOUR-DOMAIN-HERE.com` — appears in every page's `<link rel="canonical">`,
  `index.html`/`product.html`'s Open Graph/Twitter tags, `robots.txt`, and
  `sitemap.xml`. Replace with the real production domain.

## Security headers (configure at the hosting level — Hostinger/CloudPanel)

A static file server can't set real HTTP response headers, so every page just
carries `<meta name="referrer" content="strict-origin-when-cross-origin">` as
the one baseline a meta tag can actually provide. Everything below needs to be
configured server-side once there's a real host:

| Header | Recommended value | Why |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | No downside; always set this. |
| `X-Frame-Options` | `DENY` | Nothing on this site needs to be framed. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Already set via meta tag too; the header is the real enforcement point. |
| `Content-Security-Policy` | see below | Needs site-specific tuning — see caveat. |

**CSP caveat, read before turning this on:** a naive strict CSP will break
this site as currently built. Several pages (`checkout.html`, `account.html`,
`product.html`, `index.html`) have substantial **inline** `<script>` blocks
(not just external `.js` files), and JS across the codebase sets
`element.style.xxx` directly in many places (transforms, opacity, etc.) — both
of those are inline-style/inline-script usage that a strict
`script-src`/`style-src` (without `'unsafe-inline'`, a nonce, or a hash list)
will silently block. Two honest paths:

1. Ship `'unsafe-inline'` for `script-src`/`style-src` now (a real but modest
   improvement over no CSP at all — still blocks e.g. injected `<img
   src=x onerror=...>` payloads landing in `src`/`href` attributes, restricts
   `frame-ancestors`, restricts third-party script origins to an allow-list),
   e.g.:
   ```
   Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';
   ```
2. Move the remaining inline `<script>` blocks into external files first, then
   ship a real `script-src 'self' https://cdn.jsdelivr.net` with no
   `'unsafe-inline'` — meaningfully stronger, but a real refactor, not a
   drop-in header change.

## Forms — spam/abuse notes (no backend yet, so nothing is actually exploitable today)

None of `checkout.html`'s shipping form, the email-signup popup
(`js/email-popup.js`), or a future `contact.html` form talk to a real backend
yet (see the "Mock success only" comments at each submit handler) — so there's
no live endpoint to spam. Once any of them do:

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
