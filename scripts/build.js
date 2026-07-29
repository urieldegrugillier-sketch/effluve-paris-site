#!/usr/bin/env node
/* MONARK -- production build step: minifies css/*.css and js/*.js into
   dist/, and copies everything else the live site needs (the 10 top-level
   HTML pages, assets/, robots.txt, sitemap.xml) into dist/ as-is, leaving
   every source file untouched. Local development is NOT affected by this at
   all -- keep serving the project root directly for dev/testing (e.g.
   `python -m http.server`), which uses the original, unminified css/js/html
   exactly as before.

   Usage:
     npm install   (once)
     npm run build (produces/refreshes dist/)

   dist/ is a complete, self-contained mirror of the site -- css/js
   minified, everything else copied unchanged, all at the same relative
   paths as the project root (css/foo.css, js/bar.js, assets/...). That
   matters specifically because this now deploys to Cloudflare Workers
   Static Assets, which serves ONLY the configured directory's own contents
   (see wrangler.jsonc's `assets.directory` -- unlike the old Netlify setup,
   which could serve source files directly alongside dist/, nothing outside
   dist/ is reachable once deployed there). Keeping the same relative
   structure inside dist/ as the project root already has is what lets every
   page's existing relative links (css/style.css, js/account.js,
   assets/images/...) keep resolving correctly with zero rewriting, once
   dist/ itself becomes the site root. */

const fs = require('fs');
const path = require('path');
const { minify } = require('terser');
const CleanCSS = require('clean-css');

const ROOT = path.join(__dirname, '..');
const CSS_DIR = path.join(ROOT, 'css');
const JS_DIR = path.join(ROOT, 'js');
const ASSETS_DIR = path.join(ROOT, 'assets');
const DIST_DIR = path.join(ROOT, 'dist');
const DIST_CSS_DIR = path.join(DIST_DIR, 'css');
const DIST_JS_DIR = path.join(DIST_DIR, 'js');
const DIST_ASSETS_DIR = path.join(DIST_DIR, 'assets');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sizeReport(label, before, after) {
  const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  console.log(`  ${label}: ${before}B -> ${after}B (${pct}% smaller)`);
}

async function buildJs() {
  ensureDir(DIST_JS_DIR);
  const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const src = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
    const result = await minify(src, { format: { comments: false } });
    if (result.error) throw result.error;
    fs.writeFileSync(path.join(DIST_JS_DIR, file), result.code);
    sizeReport(`js/${file}`, Buffer.byteLength(src, 'utf8'), Buffer.byteLength(result.code, 'utf8'));
  }
}

function buildCss() {
  ensureDir(DIST_CSS_DIR);
  const files = fs.readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'));
  const cleanCss = new CleanCSS({ level: 2 });
  for (const file of files) {
    const src = fs.readFileSync(path.join(CSS_DIR, file), 'utf8');
    const result = cleanCss.minify(src);
    if (result.errors.length) throw new Error(result.errors.join('\n'));
    fs.writeFileSync(path.join(DIST_CSS_DIR, file), result.styles);
    sizeReport(`css/${file}`, Buffer.byteLength(src, 'utf8'), Buffer.byteLength(result.styles, 'utf8'));
  }
}

// Every top-level *.html file (404.html, index.html, product.html, etc. --
// currently 10) copied into dist/ as-is, unminified -- these aren't run
// through any minifier here (unlike css/js above), just placed at the same
// path dist/ already mirrors everything else at, so their existing relative
// links keep resolving once dist/ is the site root (see this file's own
// header comment).
function copyHtml() {
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  for (const file of files) {
    fs.copyFileSync(path.join(ROOT, file), path.join(DIST_DIR, file));
  }
  console.log(`  ${files.length} HTML file(s) copied`);
}

// assets/ (images, video, frames, icons) copied wholesale and recursively --
// binary/media files, nothing here to minify or otherwise process.
function copyAssets() {
  fs.cpSync(ASSETS_DIR, DIST_ASSETS_DIR, { recursive: true });
  console.log('  assets/ copied');
}

// robots.txt/sitemap.xml -- expected at the site root by crawlers, same
// "just needs to exist in dist/" reasoning as the HTML files above. _headers
// is Cloudflare Workers Static Assets' own convention for response headers
// (security headers, CSP, etc.) -- same reasoning: it only takes effect if
// it's actually inside the deployed assets.directory (./dist, see
// wrangler.jsonc), not the repo root.
function copyRootFiles() {
  ['robots.txt', 'sitemap.xml', '_headers'].forEach((file) => {
    fs.copyFileSync(path.join(ROOT, file), path.join(DIST_DIR, file));
  });
  console.log('  robots.txt, sitemap.xml, _headers copied');
}

async function main() {
  console.log('Building dist/ ...\n');
  ensureDir(DIST_DIR);
  console.log('CSS:');
  buildCss();
  console.log('\nJS:');
  await buildJs();
  console.log('\nHTML:');
  copyHtml();
  console.log('\nAssets:');
  copyAssets();
  console.log('\nRoot files:');
  copyRootFiles();
  console.log('\nDone. dist/ is now a complete, self-contained copy of the site -- css/js minified, everything else copied as-is at the same relative paths.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
