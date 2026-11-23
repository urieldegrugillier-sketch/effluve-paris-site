#!/usr/bin/env node
// Exports the site's three trust-bar line icons (shipping, returns, secure
// payment) as PNGs for use in emails, where inline SVG is unreliable (Gmail
// strips it). Gold (#d8b27c, the site's --accent-bronze-light) on a
// transparent background, 48x48 px, meant to be displayed at 24x24 (2x).
//
// The SVG paths are copied verbatim from the trust bar markup in index.html
// (same icons as checkout.html's trust badges). If those icons change, update
// ICONS below and rerun:
//   node scripts/export-email-icons.mjs
// Output: assets/icons/email-icon-{shipping,returns,payment}.png, which the
// build copies to dist/ so they are served from https://effluve-paris.fr.

import { chromium } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COLOR = "#d8b27c";
const SIZE = 48;

const ICONS = {
  shipping: `
    <path d="M3 6.5h11v9H3z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M14 9.5h4l3 3v3h-7z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="7" cy="17.5" r="1.6" stroke="currentColor" stroke-width="1.3"/>
    <circle cx="17.5" cy="17.5" r="1.6" stroke="currentColor" stroke-width="1.3"/>`,
  returns: `
    <path d="M3 8H18M18 8L14 4M18 8L14 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M21 16H6M6 16L10 12M6 16L10 20" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
  payment: `
    <path d="M7 10V7a5 5 0 0 1 10 0v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="4.5" y="10" width="15" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M9 15.5l2 2 4-4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
  for (const [name, paths] of Object.entries(ICONS)) {
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent;">` +
        `<svg id="icon" xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24" fill="none" style="display:block;color:${COLOR};">${paths}</svg>` +
        `</body></html>`,
    );
    const out = resolve(ROOT, `assets/icons/email-icon-${name}.png`);
    await page.locator("#icon").screenshot({ path: out, omitBackground: true });
    console.log(`wrote ${out}`);
  }
} finally {
  await browser.close();
}
