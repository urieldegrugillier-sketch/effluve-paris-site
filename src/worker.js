/* MONARK -- near-match URL redirect Worker.

   Wired up as wrangler.jsonc's `main`, alongside the existing Static Assets
   binding (`assets.binding: "ASSETS"`). With BOTH configured and
   `assets.run_worker_first` left at its default (unset/false), Cloudflare
   serves any request that matches a real file in dist/ directly, WITHOUT
   ever invoking this Worker -- it only runs for requests that already
   missed every static asset, exactly the "only runs when no static asset
   matches" behavior this was asked for. That also means this file never
   sees (and can't accidentally redirect) a request for a page, image, or
   asset that genuinely exists -- /product, /cgv.html, /assets/foo.png all
   still resolve exactly as they did before this Worker existed, the same
   way they always have, with zero code here involved.

   For everything that DOES fall through to here: normalize the path (case,
   trailing slash, .html suffix, accents, stray punctuation), and either
   redirect it to the one known route it now exactly matches (301 -- same
   canonical resource, just a different spelling of the URL), redirect it
   to the nearest known route if it's a close-enough typo (302 -- a guess,
   not a certainty, so not cached as permanent), or fall through to
   env.ASSETS.fetch() for the exact same branded dist/404.html + real 404
   status this site already serves today (assets.not_found_handling:
   "404-page", unchanged by this file).

   ROUTES comes from src/routes.generated.js, rebuilt by
   scripts/build.js's buildRoutesManifest() on every `npm run build` from
   whichever *.html files actually exist in the project root -- never
   hand-maintained here, so it can't drift out of sync with the real pages
   (see that function's own comment). */
import { ROUTES } from './routes.generated.js';

// Reasonably confident a typo without being trigger-happy: 2 edits catches
// "prduit" -> "product" (2 insertions) or a single swapped/dropped letter,
// without starting to match on real-but-unrelated words. The minimum name
// length keeps 3-letter routes (faq, cgv) out of the FUZZY path entirely --
// at that length, almost anything is within 2 edits of them, which would
// make the redirect little better than a coin flip. Short names still
// resolve correctly through the EXACT-match path above (punctuation/case/
// accent-stripping alone already turns "/faq)" or "/cgv!" into an exact
// match), they just never get guessed AT via edit distance.
export const FUZZY_MAX_DISTANCE = 2;
export const FUZZY_MIN_NAME_LENGTH = 4;

// Matches a trailing "extension-looking" suffix on the path's LAST segment
// (".png", ".js", ".xml", ...) so image/script/style/font/etc. requests --
// real or mistyped -- are recognized and left alone, never run through the
// route-matching logic below. ".html" is deliberately exempted elsewhere
// (not here) since a mistyped *page* request routinely still carries that
// extension (e.g. "produit.html") and should still get normalized/matched.
const STATIC_FILE_RE = /\.[a-z0-9]+$/i;

// Standard iterative Levenshtein (edit distance): the minimum number of
// single-character insertions/deletions/substitutions to turn `a` into `b`.
// Single-row DP (not a full matrix) -- only the previous row is ever
// needed, and these strings are short page-name lengths, not a case that
// benefits from a fancier algorithm.
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Lowercase -> decode (so a literal "%29" becomes ")", which the
// punctuation strip just below then removes same as a literal ")" would
// have) -> drop a single trailing slash -> drop the leading slash -> bail
// on anything with a REMAINING internal slash (none of the known routes
// are nested, so a multi-segment path -- "/foo/bar" -- is never a near
// miss for one of them, and mashing the segments together would risk a
// false match no actual route resembles) -> drop a trailing ".html" ->
// strip accents (NFD-decompose, then drop the standalone combining marks
// that split off) -> finally drop everything that isn't a-z/0-9/hyphen, so
// "(", ")", "!", ",", ".", ";", "'", spaces, and any encoding leftovers are
// all gone. Returns null for anything that isn't a single clean segment
// worth matching at all.
export function normalizePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (err) {
    decoded = pathname; // malformed % escape -- fall back to the raw path rather than throwing
  }
  let p = decoded.toLowerCase();
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  p = p.replace(/^\/+/, '');
  if (p === '' || p.includes('/')) return null;
  if (p.endsWith('.html')) p = p.slice(0, -'.html'.length);
  p = p.normalize('NFD').replace(/[̀-ͯ]/g, '');
  p = p.replace(/[^a-z0-9-]/g, '');
  return p || null;
}

// The actual decision, as plain data (no Request/Response/env involved) --
// kept pure and exported specifically so it can be unit-tested directly
// against a list of paths without standing up a Workers runtime at all.
// { action: 'bypass' }            -- never touch this one, fall through as-is
// { action: 'notfound' }          -- no close enough route, fall through to the real 404
// { action: 'redirect', status, path } -- 301 (exact, post-normalization) or 302 (fuzzy guess)
export function resolvePath(pathname) {
  const extMatch = pathname.match(STATIC_FILE_RE);
  const looksLikeNonHtmlFile = extMatch !== null && extMatch[0].toLowerCase() !== '.html';
  if (pathname.startsWith('/assets/') || looksLikeNonHtmlFile) {
    return { action: 'bypass' };
  }

  const cleaned = normalizePath(pathname);
  if (!cleaned) return { action: 'bypass' };

  const exact = ROUTES.find((route) => route.name === cleaned);
  if (exact) return { action: 'redirect', status: 301, path: exact.path };

  let best = null;
  let bestDistance = Infinity;
  for (const route of ROUTES) {
    if (route.name.length < FUZZY_MIN_NAME_LENGTH) continue;
    const distance = levenshtein(cleaned, route.name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = route;
    }
  }

  if (best && bestDistance <= FUZZY_MAX_DISTANCE) {
    return { action: 'redirect', status: 302, path: best.path };
  }

  return { action: 'notfound' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const decision = resolvePath(url.pathname);

    if (decision.action === 'redirect') {
      // Cloning from the real request URL (not building a bare string)
      // keeps the query string intact automatically -- only `pathname`
      // actually changes.
      const target = new URL(url);
      target.pathname = decision.path;
      return Response.redirect(target.toString(), decision.status);
    }

    // 'bypass' and 'notfound' both land here: env.ASSETS.fetch() is the
    // same lookup Cloudflare already ran before invoking this Worker at
    // all, which for a genuinely missing path resolves via
    // assets.not_found_handling ("404-page") to dist/404.html with a real
    // 404 status -- identical to today's behavior, untouched.
    return env.ASSETS.fetch(request);
  }
};
