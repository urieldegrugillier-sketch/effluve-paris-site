// MONARK: Abandoned-cart reminder emails: a two-stage nudge for a checkout
// that started (email captured at the Account step, and/or a Stripe
// PaymentIntent created at the Payment step -- see public.abandoned_checkouts'
// own migration for exactly what "started" means here) but never reached a
// 'paid' order. Stage 1 fires ~1h after the customer's last activity on that
// attempt (a plain reminder, no discount); stage 2 fires ~3h after, with a
// genuine one-time 5% code -- but only if stage 1 already fired and the cart
// still hasn't converted by then.
//
// Invoked exclusively by pg_cron (see
// 20260819000100_schedule_abandoned_cart_reminders.sql) every 15 minutes,
// never by the browser -- no CORS, no withSupabase() wrapper, same bare
// Deno.serve() pattern as stripe-webhook for the same reason (server-to-
// server only, no apikey/JWT the way a browser call would carry).
//
// auth: verify_jwt = true at the platform gateway (see supabase/config.toml)
// rejects any request with no valid Supabase-signed JWT at all, but that
// alone would still accept ANY authenticated user's own session token, not
// just the service role. The explicit check below (the bearer token must be
// exactly this project's SERVICE_ROLE_KEY) is what actually restricts this
// to the pg_cron job -- same "two layers, not one" reasoning as
// mark-order-shipped's own is_admin check stacked on top of its own
// verify_jwt = true.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
// Email builders and their constants live in ./email.ts (pure, importable;
// also used by scripts/send-test-emails.mjs for local previews).
import {
  FROM_ADDRESS,
  DISCOUNT_PERCENT,
  DISCOUNT_EXPIRES_DAYS,
  buildStage1Email,
  buildStage2Email,
} from "./email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// Deliberately NOT in the required-config check below -- same reasoning as
// stripe-webhook's own RESEND_API_KEY: a missing/invalid key must never
// crash the run (mark_converted_abandoned_checkouts() still needs to run
// regardless), it just means every send below fails individually, logged
// and swallowed same as sendConfirmationEmail()'s own pattern.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const STAGE1_DELAY_MINUTES = 60;
const STAGE2_DELAY_MINUTES = 180;
// Bounds how many rows one invocation processes per stage -- same "can't run
// away" reasoning as check-email-exists' own MAX_PAGES: at this project's
// real order volume this is never remotely close to being hit, but a
// Resend outage building up a backlog should never turn one 15-minute cron
// tick into an unbounded loop of retried sends.
const MAX_ROWS_PER_STAGE = 25;

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("send-abandoned-cart-reminders: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.");
    return new Response("Not configured.", { status: 500 });
  }
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
    return new Response("Unauthorized.", { status: 401 });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Re-evaluated fresh on every run, before either stage's own query below
  // -- this is what makes "no further emails go out once the customer
  // converts" hold even for a stage 2 that hasn't fired yet: the next tick
  // simply won't find that row as a stage-2 candidate anymore (see
  // mark_converted_abandoned_checkouts()'s own migration comment for the
  // matching logic).
  const { error: convertedError } = await supabaseAdmin.rpc("mark_converted_abandoned_checkouts");
  if (convertedError) {
    console.error("send-abandoned-cart-reminders: mark_converted_abandoned_checkouts failed:", convertedError.message);
    // Not fatal -- worst case this run's candidate queries below are stale
    // by a few minutes on conversions that just happened, caught by the
    // next tick's own (hopefully successful) sweep instead. Never worth
    // skipping the sends entirely over.
  }

  const stage1 = await processStage1(supabaseAdmin);
  const stage2 = await processStage2(supabaseAdmin);

  return Response.json({ stage1, stage2 });
});

interface AbandonedRow {
  id: string;
  email: string;
  language: string;
  discount_code: string | null;
}

interface StageResult {
  checked: number;
  sent: number;
  failed: number;
}

// ============================================================================
// Stage 1 -- plain reminder, no discount. Fires once reminder_1_sent_at is
// null, the cart is still unconverted, and last_activity_at is at least
// STAGE1_DELAY_MINUTES old. "At most once" comes entirely from
// reminder_1_sent_at only ever being set AFTER a confirmed Resend accept
// (never before attempting the send) -- same convention as stripe-webhook's
// own orders.email_sent (see that function's own comment on why a stuck
// false is the deliberate, accepted failure mode, not a blocker).
// ============================================================================
async function processStage1(supabaseAdmin: ReturnType<typeof createClient>): Promise<StageResult> {
  const cutoff = new Date(Date.now() - STAGE1_DELAY_MINUTES * 60 * 1000).toISOString();
  const { data: rows, error } = await supabaseAdmin
    .from("abandoned_checkouts")
    .select("id, email, language, discount_code")
    .is("reminder_1_sent_at", null)
    .is("converted_at", null)
    .lte("last_activity_at", cutoff)
    .order("last_activity_at", { ascending: true })
    .limit(MAX_ROWS_PER_STAGE);

  if (error) {
    console.error("send-abandoned-cart-reminders: stage 1 candidate query failed:", error.message);
    return { checked: 0, sent: 0, failed: 0 };
  }

  const result: StageResult = { checked: (rows || []).length, sent: 0, failed: 0 };
  for (const row of (rows || []) as AbandonedRow[]) {
    try {
      const language = row.language === "en" ? "en" : "fr";
      const { subject, html, text } = buildStage1Email(language);
      await sendReminderEmail(row.email, subject, html, text);
      const { error: updateError } = await supabaseAdmin
        .from("abandoned_checkouts")
        .update({ reminder_1_sent_at: new Date().toISOString() })
        .eq("id", row.id);
      if (updateError) throw updateError;
      result.sent++;
    } catch (err) {
      result.failed++;
      console.error("send-abandoned-cart-reminders: stage 1 failed for row", row.id, ":", err instanceof Error ? err.message : err);
    }
  }
  return result;
}

// ============================================================================
// Stage 2 -- second reminder with a genuine one-time 5% code. Fires once
// reminder_1_sent_at is set (stage 1 already went out), reminder_2_sent_at
// is still null, the cart is still unconverted, and last_activity_at is at
// least STAGE2_DELAY_MINUTES old.
//
// Per-customer unique code, not a single shared "COMEBACK5"-style code --
// deliberate choice, reusing public.promo_codes as-is rather than inventing
// a separate discount mechanism:
//   - max_uses = 1 on an individually-generated code is what makes "at most
//     one discount per abandoned cart" hold using promo_codes' OWN existing
//     active/expires_at/max_uses enforcement (already checked identically by
//     both validate-promo-code and create-checkout-session, see their own
//     comments) -- no new redemption logic needed anywhere. A single shared
//     code would need EITHER an unlimited max_uses (can't cap it per
//     customer at all) or a low shared cap that has nothing to do with how
//     many reminder emails actually went out.
//   - A shared code is also a code that can leak onto a coupon-aggregator
//     site and get redeemed by people who never abandoned anything --
//     a per-customer code minted only at send time, mailed only to that one
//     address, has no such exposure.
// ============================================================================
async function processStage2(supabaseAdmin: ReturnType<typeof createClient>): Promise<StageResult> {
  const cutoff = new Date(Date.now() - STAGE2_DELAY_MINUTES * 60 * 1000).toISOString();
  const { data: rows, error } = await supabaseAdmin
    .from("abandoned_checkouts")
    .select("id, email, language, discount_code")
    .not("reminder_1_sent_at", "is", null)
    .is("reminder_2_sent_at", null)
    .is("converted_at", null)
    .lte("last_activity_at", cutoff)
    .order("last_activity_at", { ascending: true })
    .limit(MAX_ROWS_PER_STAGE);

  if (error) {
    console.error("send-abandoned-cart-reminders: stage 2 candidate query failed:", error.message);
    return { checked: 0, sent: 0, failed: 0 };
  }

  const result: StageResult = { checked: (rows || []).length, sent: 0, failed: 0 };
  for (const row of (rows || []) as AbandonedRow[]) {
    try {
      const language = row.language === "en" ? "en" : "fr";
      // Reuses an already-minted code if one exists on this row (a previous
      // run got as far as generating/persisting it but the send itself
      // failed) rather than minting a second, orphaned promo_codes row for
      // the same abandoned cart -- see ensureDiscountCode()'s own comment.
      const discountCode = await ensureDiscountCode(supabaseAdmin, row);
      const { subject, html, text } = buildStage2Email(language, discountCode);
      await sendReminderEmail(row.email, subject, html, text);
      const { error: updateError } = await supabaseAdmin
        .from("abandoned_checkouts")
        .update({ reminder_2_sent_at: new Date().toISOString() })
        .eq("id", row.id);
      if (updateError) throw updateError;
      result.sent++;
    } catch (err) {
      result.failed++;
      console.error("send-abandoned-cart-reminders: stage 2 failed for row", row.id, ":", err instanceof Error ? err.message : err);
    }
  }
  return result;
}

// 8-char alphanumeric suffix, same charset/length/collision-retry idiom as
// stripe-webhook's own generateReferenceCode()/order reference loop
// (excludes ambiguous glyphs O/0, I/1, L -- readable if a customer ever has
// to read it out over a support call). "BACK5-" prefix makes an
// abandoned-cart-generated code instantly recognizable next to
// admin-managed ones like MONARK10 in admin.html's Promo Codes tab.
const CODE_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_SUFFIX_LENGTH = 6;
const MAX_CODE_ATTEMPTS = 8;

function generateDiscountCode(): string {
  let suffix = "";
  for (let i = 0; i < CODE_SUFFIX_LENGTH; i++) {
    suffix += CODE_CHARSET[Math.floor(Math.random() * CODE_CHARSET.length)];
  }
  return `BACK5-${suffix}`;
}

async function ensureDiscountCode(
  supabaseAdmin: ReturnType<typeof createClient>,
  row: AbandonedRow,
): Promise<string> {
  if (row.discount_code) return row.discount_code;

  const expiresAt = new Date(Date.now() + DISCOUNT_EXPIRES_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateDiscountCode();
    const { error: insertError } = await supabaseAdmin.from("promo_codes").insert({
      code,
      discount_percent: DISCOUNT_PERCENT,
      active: true,
      max_uses: 1,
      expires_at: expiresAt,
    });
    if (!insertError) {
      // Persisted onto the row IMMEDIATELY (before the email is even sent)
      // so a Resend failure right after this still reuses this exact code
      // on the next cron tick's retry, rather than this function minting a
      // second one and leaving the first an orphaned, never-emailed
      // promo_codes row.
      const { error: updateError } = await supabaseAdmin
        .from("abandoned_checkouts")
        .update({ discount_code: code })
        .eq("id", row.id);
      if (updateError) throw updateError;
      return code;
    }
    lastError = insertError;
    // 23505 on promo_codes.code's own unique constraint -- vanishingly
    // unlikely at 8 random chars, but retried the same way
    // stripe-webhook's own reference-number generation is, rather than
    // assumed impossible.
    if ((insertError as { code?: string }).code !== "23505") break;
  }
  throw lastError instanceof Error ? lastError : new Error("send-abandoned-cart-reminders: exhausted discount code generation attempts");
}

async function sendReminderEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  if (!RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html, text }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Resend API responded ${res.status}: ${errBody}`);
  }
}
