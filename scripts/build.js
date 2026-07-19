#!/usr/bin/env node
/* MONARK -- production build step: minifies css/*.css and js/*.js into dist/,
   leaving every source file untouched. Local development is NOT affected by
   this at all -- keep serving the project root directly for dev/testing
   (e.g. `python -m http.server`), which uses the original, unminified
   css/js/html exactly as before.

   Usage:
     npm install   (once)
     npm run build (produces/refreshes dist/css and dist/js)

   dist/ mirrors css/ and js/ with the same filenames, minified. Pointing an
   actual deployment at dist/ (or copying its contents over css/js at deploy
   time) is a separate step, left for whichever hosting/deploy process gets
   set up later. */

const fs = require('fs');
const path = require('path');
const { minify } = require('terser');
const CleanCSS = require('clean-css');

const ROOT = path.join(__dirname, '..');
const CSS_DIR = path.join(ROOT, 'css');
const JS_DIR = path.join(ROOT, 'js');
const DIST_CSS_DIR = path.join(ROOT, 'dist', 'css');
const DIST_JS_DIR = path.join(ROOT, 'dist', 'js');

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

async function main() {
  console.log('Building minified assets into dist/ ...\n');
  console.log('CSS:');
  buildCss();
  console.log('\nJS:');
  await buildJs();
  console.log('\nDone. dist/css and dist/js now mirror css/ and js/, minified. Source files untouched.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
