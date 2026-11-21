#!/usr/bin/env node
// Local preview: builds the signup verification-code email with a FAKE code
// (123456) using the exact same builder the production Send Email Hook uses
// (supabase/functions/send-auth-email/email.ts), and sends it via Resend to
// a test inbox so it can be checked in real mail clients.
//
// It never touches Supabase (no users, no auth calls, no hook invocation):
// the only network call is one POST to the Resend API.
//
// Usage (Node 24+, which runs the imported .ts file natively):
//   npm run test:auth-email               (French)
//   npm run test:auth-email -- --lang=en  (English)
//
// RESEND_API_KEY is read from the environment, or else from a gitignored
// .env file at the repo root (line: RESEND_API_KEY=re_...). It is never
// printed. Optional TEST_EMAIL_TO overrides the recipient.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAuthEmail, FROM_ADDRESS } from "../supabase/functions/send-auth-email/email.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TO = "urieldegrugillier@gmail.com";
const FAKE_CODE = "123456";

const envFile = resolve(ROOT, ".env");
if (!process.env.RESEND_API_KEY && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const apiKey = (process.env.RESEND_API_KEY || "").trim();
if (!apiKey) {
  console.error("RESEND_API_KEY is not set. Set it for this command, or add RESEND_API_KEY=... to a .env file at the repo root (gitignored).");
  process.exit(1);
}

const langArg = process.argv.slice(2).find((a) => a.startsWith("--lang"));
const langValue = langArg?.includes("=") ? langArg.split("=")[1] : process.argv[process.argv.indexOf(langArg) + 1];
const language = langValue === "en" ? "en" : "fr";
const to = process.env.TEST_EMAIL_TO || DEFAULT_TO;

const { subject, html, text } = buildAuthEmail("signup", language, undefined, FAKE_CODE);

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html, text }),
});

if (!res.ok) {
  const body = await res.text().catch(() => "");
  console.error(`Resend responded ${res.status}: ${body}`);
  process.exit(1);
}
const { id } = await res.json().catch(() => ({}));
console.log(`Sent test signup email (${language.toUpperCase()}) to ${to}. Resend id: ${id ?? "unknown"}`);
