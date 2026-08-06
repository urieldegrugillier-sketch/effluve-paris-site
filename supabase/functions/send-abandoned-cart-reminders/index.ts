// MONARK — Abandoned-cart reminder emails: a two-stage nudge for a checkout
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// Deliberately NOT in the required-config check below -- same reasoning as
// stripe-webhook's own RESEND_API_KEY: a missing/invalid key must never
// crash the run (mark_converted_abandoned_checkouts() still needs to run
// regardless), it just means every send below fails individually, logged
// and swallowed same as sendConfirmationEmail()'s own pattern.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

// Same sending identity/domain/asset URLs as stripe-webhook's own
// order-confirmation email -- see that function's own comments for why each
// one is what it is (contact@ for reply-forwarding, PNG not SVG/WebP for
// Outlook compatibility, etc.). Duplicated here rather than imported --
// matches this project's existing "self-contained single-file functions, no
// _shared/ import between them" convention (see create-checkout-session's
// own comment on that).
const FROM_ADDRESS = "Effluve Paris <contact@effluve-paris.fr>";
const WEBSITE_URL = "https://effluve-paris.fr";
const LOGO_URL = `${WEBSITE_URL}/assets/icons/effluve-word-dark-bg.png`;
const PARIS_LOGO_URL = `${WEBSITE_URL}/assets/icons/paris-word-dark-bg.png`;
const PRODUCT_THUMB_URL = `${WEBSITE_URL}/assets/images/email-product-thumb.png`;
const PRODUCT_URL = `${WEBSITE_URL}/product.html`;
// Matches js/cart.js's own single hardcoded PRODUCT.name -- this project's
// one current MONARK edition (same fallback stripe-webhook itself uses, see
// its own DEFAULT_PRODUCT_NAME). There's no persisted per-attempt cart
// contents to read a real product name from -- carts live in localStorage
// only, never synced server-side before checkout completes -- so this is
// deliberately the one thing this project actually sells, not a guess.
const PRODUCT_NAME = "MONARK Eau de Parfum | 100ml";

const STAGE1_DELAY_MINUTES = 60;
const STAGE2_DELAY_MINUTES = 180;
// Bounds how many rows one invocation processes per stage -- same "can't run
// away" reasoning as check-email-exists' own MAX_PAGES: at this project's
// real order volume this is never remotely close to being hit, but a
// Resend outage building up a backlog should never turn one 15-minute cron
// tick into an unbounded loop of retried sends.
const MAX_ROWS_PER_STAGE = 25;

const DISCOUNT_PERCENT = 5;
const DISCOUNT_EXPIRES_DAYS = 7;

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================================
// Shared visual shell -- same dark card/logo header/legal footer chrome as
// stripe-webhook's own buildConfirmationEmail() (colors, fonts, dark-mode
// meta tags/Outlook data-ogsc hook, PNG logos, table-based two-column
// product layout), reused for both stages here since they're one file, not
// two separate Edge Functions -- the "no shared code between functions"
// convention this project follows is about not importing across DIFFERENT
// deployed functions, not about duplicating markup within the same one.
// ============================================================================
interface ReminderEmailContent {
  language: "fr" | "en";
  preheader: string;
  heading: string;
  bodyHtml: string;
  bodyText: string[];
  ctaLabel: string;
}

function buildReminderEmail(content: ReminderEmailContent): { subject: string; html: string; text: string } {
  const isFr = content.language === "fr";
  const labels = {
    terms: isFr ? "CGV" : "Terms of Sale",
    privacy: isFr ? "Confidentialité" : "Privacy Policy",
  };
  const legalFooterHtml = `<a href="${WEBSITE_URL}" style="color:#8f887c;">Effluve Paris</a> — <a href="${WEBSITE_URL}/cgv.html" style="color:#8f887c;">${labels.terms}</a> · <a href="${WEBSITE_URL}/confidentialite.html" style="color:#8f887c;">${labels.privacy}</a>`;
  const legalFooterText = `Effluve Paris (${WEBSITE_URL}) — ${labels.terms}: ${WEBSITE_URL}/cgv.html — ${labels.privacy}: ${WEBSITE_URL}/confidentialite.html`;

  const html = `<!doctype html>
<html lang="${content.language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <style>
      :root { color-scheme: light dark; supported-color-schemes: light dark; }
      [data-ogsc] body, [data-ogsc] .email-bg { background-color: #0a0908 !important; }
      [data-ogsc] .email-card { background-color: #141210 !important; }
      [data-ogsc] h1, [data-ogsc] p, [data-ogsc] td, [data-ogsc] span, [data-ogsc] a { color: #ede7dd !important; }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#0a0908;font-family:'Manrope',Arial,sans-serif;color:#ede7dd;">
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${content.preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0a0908" class="email-bg" style="background:#0a0908;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#141210" class="email-card" style="max-width:520px;background:#141210;border:1px solid #2a2620;">
            <tr>
              <td style="padding:32px 32px 24px;text-align:center;border-bottom:1px solid #2a2620;">
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td align="center">
                      <a href="${WEBSITE_URL}"><img src="${LOGO_URL}" width="220" height="36" alt="Effluve Paris" style="display:block;border:0;outline:none;width:220px;height:36px;"></a>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="padding-top:6px;">
                      <a href="${WEBSITE_URL}"><img src="${PARIS_LOGO_URL}" width="83" height="13" alt="Paris" style="display:block;border:0;outline:none;width:83px;height:13px;"></a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#ede7dd;">${content.heading}</h1>
                ${content.bodyHtml}
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;border-collapse:collapse;table-layout:fixed;">
                  <tr>
                    <td width="120" valign="top" style="padding:0 16px 0 0;">
                      <a href="${PRODUCT_URL}"><img src="${PRODUCT_THUMB_URL}" width="120" height="120" alt="${escapeHtml(PRODUCT_NAME)}" style="display:block;border:0;outline:none;width:120px;height:120px;border-radius:4px;"></a>
                    </td>
                    <td valign="top">
                      <p style="margin:0;font-size:15px;font-weight:600;line-height:1.35;color:#d8b27c;">${escapeHtml(PRODUCT_NAME)}</p>
                    </td>
                  </tr>
                </table>
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:28px auto 0;">
                  <tr>
                    <td style="background:#9c6b2e;border:1px solid #9c6b2e;" align="center">
                      <a href="${PRODUCT_URL}" style="display:inline-block;padding:14px 32px;font-family:'IBM Plex Mono',Consolas,monospace;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#000000;text-decoration:none;">${content.ctaLabel}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px;border-top:1px solid #2a2620;text-align:center;">
                <p style="margin:0;font-size:11px;color:#6b655c;">${legalFooterHtml}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    "EFFLUVE PARIS",
    "",
    ...content.bodyText,
    "",
    `${PRODUCT_NAME}`,
    "",
    `${content.ctaLabel}: ${PRODUCT_URL}`,
    "",
    "---",
    legalFooterText,
  ].join("\n");

  return { subject: content.preheader, html, text };
}

function buildStage1Email(language: "fr" | "en"): { subject: string; html: string; text: string } {
  const isFr = language === "fr";
  const subject = isFr ? "Vous avez oublié quelque chose…" : "You left something behind…";
  const heading = isFr ? "Votre commande vous attend" : "Your order is waiting for you";
  const bodyHtml = isFr
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">Vous avez commencé une commande chez Effluve Paris, mais elle n'a pas été finalisée.</p>
       <p style="margin:0;font-size:14px;line-height:1.6;color:#ede7dd;">Il ne vous reste qu'une étape pour la compléter.</p>`
    : `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">You started an order with Effluve Paris, but it wasn't completed.</p>
       <p style="margin:0;font-size:14px;line-height:1.6;color:#ede7dd;">Just one step left to finish it.</p>`;
  const bodyText = isFr
    ? ["Vous avez commencé une commande chez Effluve Paris, mais elle n'a pas été finalisée.", "Il ne vous reste qu'une étape pour la compléter."]
    : ["You started an order with Effluve Paris, but it wasn't completed.", "Just one step left to finish it."];
  const ctaLabel = isFr ? "Finaliser ma commande" : "Complete my order";

  const built = buildReminderEmail({ language, preheader: subject, heading, bodyHtml, bodyText, ctaLabel });
  return { ...built, subject };
}

function buildStage2Email(language: "fr" | "en", discountCode: string): { subject: string; html: string; text: string } {
  const isFr = language === "fr";
  const subject = isFr ? `-5% sur votre commande | ${discountCode}` : `5% off your order | ${discountCode}`;
  const heading = isFr ? "Un dernier geste pour vous" : "One last thing for you";
  const discountBlockHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;border-collapse:collapse;">
      <tr>
        <td style="padding:16px;background:rgba(216,178,124,0.08);border:1px dashed #d8b27c;text-align:center;">
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#8f887c;">${isFr ? "Votre code" : "Your code"}</p>
          <p style="margin:0;font-family:'IBM Plex Mono',Consolas,monospace;font-size:20px;font-weight:600;letter-spacing:0.08em;color:#d8b27c;">${escapeHtml(discountCode)}</p>
        </td>
      </tr>
    </table>`;
  const validityNoteHtml = isFr
    ? `<p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:#8f887c;">Valable ${DISCOUNT_EXPIRES_DAYS} jours, à usage unique.</p>`
    : `<p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:#8f887c;">Valid for ${DISCOUNT_EXPIRES_DAYS} days, single use.</p>`;
  const bodyHtml = isFr
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">Votre commande chez Effluve Paris n'a toujours pas été finalisée.</p>
       <p style="margin:0;font-size:14px;line-height:1.6;color:#ede7dd;">Voici <strong>${DISCOUNT_PERCENT}%</strong> de réduction pour vous aider à franchir le pas.</p>
       ${discountBlockHtml}${validityNoteHtml}`
    : `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#ede7dd;">Your Effluve Paris order still hasn't been completed.</p>
       <p style="margin:0;font-size:14px;line-height:1.6;color:#ede7dd;">Here's <strong>${DISCOUNT_PERCENT}%</strong> off to help you take the last step.</p>
       ${discountBlockHtml}${validityNoteHtml}`;
  const bodyText = isFr
    ? [
        "Votre commande chez Effluve Paris n'a toujours pas été finalisée.",
        `Voici ${DISCOUNT_PERCENT}% de réduction pour vous aider à franchir le pas.`,
        "",
        `Votre code : ${discountCode}`,
        `Valable ${DISCOUNT_EXPIRES_DAYS} jours, à usage unique.`,
      ]
    : [
        "Your Effluve Paris order still hasn't been completed.",
        `Here's ${DISCOUNT_PERCENT}% off to help you take the last step.`,
        "",
        `Your code: ${discountCode}`,
        `Valid for ${DISCOUNT_EXPIRES_DAYS} days, single use.`,
      ];
  const ctaLabel = isFr ? "Utiliser mon code" : "Use my code";

  const built = buildReminderEmail({ language, preheader: subject, heading, bodyHtml, bodyText, ctaLabel });
  return { ...built, subject };
}
