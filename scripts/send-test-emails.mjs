#!/usr/bin/env node
// Local preview of EVERY transactional email the site sends. Each email is
// built with fake data (scripts/test-emails/catalog.mjs) by the exact same
// builders the production edge functions use (supabase/functions/*/email.ts),
// then sent through Resend with the subject prefixed "[TEST] ".
//
// It never touches Supabase, Stripe, Ship24 or real orders: the only network
// calls are POSTs to the Resend API (none at all with --dry-run).
//
// Usage (Node 24+, which runs the imported .ts files natively):
//   npm run test:emails                          all emails, French
//   npm run test:emails -- --lang=en             all emails, English
//   npm run test:emails -- --only=delivered      just one (see --list)
//   npm run test:emails -- --list                print the email names
//   npm run test:emails -- --dry-run             build everything, send nothing
//
// RESEND_API_KEY is read from the environment, or else from a gitignored
// .env file at the repo root (line: RESEND_API_KEY=re_...). It is never
// printed. Optional TEST_EMAIL_TO overrides the recipient.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as auth from "../supabase/functions/send-auth-email/email.ts";
import * as order from "../supabase/functions/stripe-webhook/email.ts";
import * as shipped from "../supabase/functions/mark-order-shipped/email.ts";
import * as delivered from "../supabase/functions/ship24-webhook/email.ts";
import * as cart from "../supabase/functions/send-abandoned-cart-reminders/email.ts";
import { emailCatalog } from "./test-emails/catalog.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TO = "urieldegrugillier@gmail.com";
const FROM_ADDRESS = "Effluve Paris <contact@effluve-paris.fr>";
const PAUSE_MS = 1200; // Resend's default limit is 2 requests/second.

function argValue(name) {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i];
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
}
const hasFlag = (name) => process.argv.slice(2).includes(`--${name}`);

const language = argValue("lang") === "en" ? "en" : "fr";
const only = argValue("only");
const dryRun = hasFlag("dry-run");
const catalog = emailCatalog(language, { auth, order, shipped, delivered, cart });

if (hasFlag("list")) {
  for (const e of catalog) console.log(e.name);
  process.exit(0);
}

const selected = only ? catalog.filter((e) => e.name === only) : catalog;
if (!selected.length) {
  console.error(`Unknown email "${only}". Available: ${catalog.map((e) => e.name).join(", ")}`);
  process.exit(1);
}

// Build everything first, so a broken builder fails before anything is sent.
const built = selected.map((e) => ({ name: e.name, ...e.build() }));

if (dryRun) {
  console.log(`Dry run (${language.toUpperCase()}), built without sending:`);
  for (const e of built) console.log(`  ${e.name}`);
  process.exit(0);
}

const envFile = resolve(ROOT, ".env");
if (!process.env.RESEND_API_KEY && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
const apiKey = (process.env.RESEND_API_KEY || "").trim();
if (!apiKey) {
  console.error("RESEND_API_KEY is not set. Set it for this command, or add RESEND_API_KEY=... to a .env file at the repo root (gitignored).");
  process.exit(1);
}
const to = process.env.TEST_EMAIL_TO || DEFAULT_TO;

const sent = [];
const failed = [];
for (const [i, e] of built.entries()) {
  if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject: `[TEST] ${e.subject}`, html: e.html, text: e.text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Resend responded ${res.status}: ${body}`);
    }
    sent.push(e.name);
  } catch (err) {
    failed.push(e.name);
    console.error(`${e.name}: ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`Sent ${sent.length}/${built.length} (${language.toUpperCase()}) to ${to}:`);
for (const name of sent) console.log(`  ${name}`);
if (failed.length) {
  console.log("Failed:");
  for (const name of failed) console.log(`  ${name}`);
  process.exit(1);
}
