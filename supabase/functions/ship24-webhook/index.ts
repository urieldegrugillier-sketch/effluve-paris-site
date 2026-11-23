// Effluve Paris: Ship24 delivery webhook. Ship24 pushes a tracking update
// here every time something changes on a tracker this project created (see
// supabase/functions/mark-order-shipped's own createShip24Tracker(), which
// creates one right after an order is marked shipped and stores the
// trackerId Ship24 returns on orders.ship24_tracker_id). The only status
// this function actually acts on is "delivered": it sets orders.delivered_at
// to the delivery event's own timestamp and sends a "delivered" confirmation
// email, mirroring mark-order-shipped's own shipping-notification email.
//
// This replaces supabase/functions/check-delivery-status, a polling-based
// placeholder scaffolded before Ship24 was chosen -- that function has been
// deleted. A webhook is strictly better for this project's actual
// situation: the free tier is capped at 10 tracked shipments/month, and a
// cron job polling every tracker on a fixed schedule forever would burn
// through API calls whether or not anything actually changed, while a
// webhook only ever fires when Ship24 itself has something new to report.
//
// ============================================================================
// MANUAL SETUP STEPS (Ship24 Dashboard) -- this environment can't do these
// for you:
//
// 1. Deploy this function first (`supabase functions deploy ship24-webhook
//    --linked`) so step 2 has a real URL to point at.
// 2. Ship24 Dashboard -> https://dashboard.ship24.com/integrations/webhook/
//    -> set the webhook URL to (this project's ref, from
//    js/supabase-client.js's own SUPABASE_URL, is kqpekwaoklqlrdpdlqbx):
//      https://kqpekwaoklqlrdpdlqbx.supabase.co/functions/v1/ship24-webhook
// 3. That same page shows an auto-generated "Webhook Secret" (Ship24
//    assigns this, not something to invent) -- copy it, then set it as a
//    Supabase secret -- NEVER hardcode it here or commit it:
//      supabase secrets set SHIP24_WEBHOOK_SECRET=<paste the secret> --linked
//    Without it set, every incoming webhook fails the auth check below and
//    this function responds 401 -- Ship24 retries failed deliveries with
//    backoff for a while, so setting it slightly late is recoverable, but
//    deliveries older than its retry window are not.
// 4. Not this function's own concern, but required for step 2's URL to ever
//    receive anything: supabase/functions/mark-order-shipped needs
//    SHIP24_API_KEY set (see that function's own comment) for it to create
//    trackers in the first place. Also unverified without a real key to
//    test against: whether a newly-created tracker automatically starts
//    pushing to whatever webhook URL is configured account-wide (this
//    function's own working assumption, based on Ship24's webhook
//    configuration being account-level, not a per-tracker-creation
//    request field in their own API) -- worth confirming once real
//    tracking activity exists, via the tracker-creation response's own
//    `isSubscribed` field or Ship24's support if deliveries don't arrive.
// ============================================================================
//
// auth: none of this project's usual withSupabase()/verify_jwt machinery --
// Ship24's own servers call this directly, with no Supabase apikey/JWT at
// all (see supabase/config.toml's own verify_jwt = false for this function,
// same reasoning as stripe-webhook's own comment on why: the platform's JWT
// gateway would reject every incoming Ship24 request before this code ever
// ran, since Ship24 never sends a Supabase-signed token). Trust instead
// comes entirely from the bearer secret Ship24 sends in the Authorization
// header, verified below against SHIP24_WEBHOOK_SECRET -- the one and only
// gate on this endpoint.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
// Email builders and their constants live in ./email.ts (pure, importable;
// also used by scripts/send-test-emails.mjs for local previews).
import {
  FROM_ADDRESS,
  buildDeliveredEmail,
  REPLY_TO_ADDRESS,
} from "./email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SHIP24_WEBHOOK_SECRET = Deno.env.get("SHIP24_WEBHOOK_SECRET");
// Same "missing key never blocks the core job" degradation as every other
// notification email in this project -- delivered_at still gets set below
// even if this is missing, only the email is skipped.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SHIP24_WEBHOOK_SECRET) {
    console.error("ship24-webhook: missing required environment configuration.");
    return new Response("Not configured.", { status: 500 });
  }
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader !== `Bearer ${SHIP24_WEBHOOK_SECRET}`) {
    return new Response("Unauthorized.", { status: 401 });
  }

  let body: { trackings?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON.", { status: 400 });
  }
  const trackings = Array.isArray(body.trackings) ? body.trackings : [];

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let processed = 0;
  let delivered = 0;
  for (const tracking of trackings) {
    processed++;
    // Never lets one malformed/unexpected tracking entry in the batch take
    // the rest down with it -- same "keep going, log, move on" resilience
    // every other batch/loop in this project's functions already has (see
    // send-abandoned-cart-reminders' own per-row try/catch).
    try {
      if (await handleTracking(supabaseAdmin, tracking)) delivered++;
    } catch (err) {
      console.error("ship24-webhook: failed to process a tracking entry:", err instanceof Error ? err.message : err);
    }
  }

  // Always 2xx once auth/config passed and the body at least parsed --
  // Ship24 only needs to know the batch was received, not that every
  // individual tracking in it matched a known order (an untracked/stale
  // trackerId is an expected, non-error outcome, not something worth Ship24
  // retrying delivery of).
  return Response.json({ processed, delivered });
});

interface TrackingPayload {
  tracker?: { trackerId?: unknown };
  shipment?: { statusMilestone?: unknown };
  events?: Array<{ statusMilestone?: unknown; occurrenceDatetime?: unknown }>;
}

// Returns true if this tracking entry resulted in delivered_at actually
// being set (i.e. a genuinely new delivery, not a duplicate/retried
// webhook for one already recorded) -- purely for the processed/delivered
// counts in the response above, not otherwise consumed.
async function handleTracking(
  supabaseAdmin: ReturnType<typeof createClient>,
  raw: unknown,
): Promise<boolean> {
  const tracking = raw as TrackingPayload;
  const trackerId = tracking?.tracker?.trackerId;
  if (typeof trackerId !== "string" || !trackerId) return false;

  // shipment.statusMilestone is the shipment's own CURRENT overall status
  // (not just "since last push", unlike events -- see occurrenceDatetime's
  // own comment below) -- the authoritative check for "is this delivered
  // yet", regardless of which specific event triggered this webhook call.
  const statusMilestone = tracking?.shipment?.statusMilestone;
  if (statusMilestone !== "delivered") return false;

  const { data: order, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("id, reference_number, product_name, user_id, guest_email, language, delivered_at")
    .eq("ship24_tracker_id", trackerId)
    .maybeSingle();
  if (orderError) {
    console.error("ship24-webhook: order lookup failed for trackerId", trackerId, ":", orderError.message);
    return false;
  }
  if (!order) {
    // Expected for a stale/test tracker, or a corrected order whose
    // ship24_tracker_id has since moved to a newer tracker (see
    // createShip24Tracker()'s own comment) -- not an error.
    return false;
  }
  if (order.delivered_at) return false; // already recorded -- duplicate/retried webhook

  // Ship24 webhooks only ever carry events "discovered since the last
  // push" (per Ship24's own API reference), ordered newest-first -- for a
  // delivered notification, events[0] is the delivery event itself, and
  // its occurrenceDatetime is the real moment it happened (per Ship24's
  // carrier data), more accurate than "whenever this webhook happened to
  // be received." occurrenceDatetime has no explicit timezone marker in
  // Ship24's own examples (their custom "logistic-date-time" format) --
  // treated as UTC (a 'Z' appended if not already present) since that's
  // the safe, defensible default for a value with no stated offset;
  // falls back to the moment this webhook was actually received if the
  // event timestamp is missing or fails to parse at all.
  const eventDatetime = tracking?.events?.[0]?.occurrenceDatetime;
  const deliveredAt = parseShip24Datetime(typeof eventDatetime === "string" ? eventDatetime : null);

  // .is("delivered_at", null) makes this update conditional -- if another
  // (near-simultaneous, retried) webhook call already won this exact race,
  // this update matches zero rows and .select() below comes back empty,
  // which is this function's own signal to skip the email rather than
  // sending it twice.
  const { data: updated, error: updateError } = await supabaseAdmin
    .from("orders")
    .update({ delivered_at: deliveredAt })
    .eq("id", order.id)
    .is("delivered_at", null)
    .select("id");
  if (updateError) {
    console.error("ship24-webhook: delivered_at update failed for order", order.id, ":", updateError.message);
    return false;
  }
  if (!updated || updated.length === 0) return false;

  await sendDeliveredEmail(supabaseAdmin, order, deliveredAt);
  return true;
}

function parseShip24Datetime(value: string | null): string {
  if (value) {
    const withTz = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
    const parsed = new Date(withTz);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

interface OrderRow {
  id: string;
  reference_number: string | null;
  product_name: string;
  user_id: string | null;
  guest_email: string | null;
  language: string | null;
}

// Identical to mark-order-shipped's own resolveCustomerEmailAndName() --
// duplicated rather than imported, same "self-contained functions"
// convention as the constants above.
async function resolveCustomerEmailAndName(
  supabaseAdmin: ReturnType<typeof createClient>,
  order: OrderRow,
): Promise<{ email: string | null; firstName: string }> {
  if (order.user_id) {
    const [{ data: profile }, { data: authUser, error: authError }] = await Promise.all([
      supabaseAdmin.from("profiles").select("first_name").eq("id", order.user_id).maybeSingle(),
      supabaseAdmin.auth.admin.getUserById(order.user_id),
    ]);
    if (authError) {
      console.error("ship24-webhook: auth.admin.getUserById failed:", authError.message);
    }
    return { email: authUser?.user?.email || null, firstName: profile?.first_name || "" };
  }
  if (order.guest_email) {
    return { email: order.guest_email, firstName: "" };
  }
  return { email: null, firstName: "" };
}

async function sendDeliveredEmail(
  supabaseAdmin: ReturnType<typeof createClient>,
  order: OrderRow,
  deliveredAtIso: string,
) {
  const { email, firstName } = await resolveCustomerEmailAndName(supabaseAdmin, order);
  if (!email) {
    console.error("ship24-webhook: no resolvable email for order", order.id, "-- delivered notification skipped.");
    return;
  }
  if (!RESEND_API_KEY) {
    console.error("ship24-webhook: RESEND_API_KEY is not configured -- skipping delivered notification for order", order.id);
    return;
  }

  const language: "fr" | "en" = order.language === "en" ? "en" : "fr"; // matches js/i18n.js's own DEFAULT_LANG = 'fr'
  const { subject, html, text } = buildDeliveredEmail({
    language,
    firstName,
    referenceNumber: order.reference_number || "",
    productName: order.product_name,
    deliveredAtIso,
  });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_ADDRESS, reply_to: REPLY_TO_ADDRESS, to: [email], subject, html, text }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Resend API responded ${res.status}: ${errBody}`);
    }
  } catch (err) {
    console.error("ship24-webhook: delivered notification email failed for order", order.id, ":", err instanceof Error ? err.message : err);
  }
}
