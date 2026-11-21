// Effluve Paris: admin.html's own privileged action: mark an order shipped
// (or correct an already-shipped order's tracking number) and send the
// matching customer email. Called from js/admin.js via
// supabase.functions.invoke('mark-order-shipped', ...), NOT a direct
// supabase-js .from('orders').update() the way the rest of this project's
// client code talks to Postgres -- the Resend API key this needs has to
// stay server-side only (same reasoning as supabase/functions/
// stripe-webhook's own FROM_ADDRESS/RESEND_API_KEY), so sending the email
// can't happen from admin.js itself. The actual row UPDATE could still go
// through RLS directly from the browser (see the "Admins can update
// shipping fields" policy in supabase/migrations/20260806000000_admin_
// shipping.sql, still in place as a defense-in-depth backstop) -- routing
// it through here too just keeps "was this a first-time ship or a
// correction, and which email does that mean" as one authoritative,
// server-side decision instead of trusting the client to report it
// honestly.
//
// auth: unlike create-checkout-session/check-email-exists (both
// withSupabase({auth:"publishable"}), callable by anyone including guests),
// this one needs to know WHICH real, signed-in user is calling and whether
// THEY specifically are an admin -- not something a bare publishable-key
// check can answer. Raw Deno.serve + manual JWT handling (same "no
// withSupabase" choice stripe-webhook already made, for its own different
// reason) rather than guessing at an "authenticated" mode this project's
// existing withSupabase() call sites never needed.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
// Email builders and their constants live in ./email.ts (pure, importable;
// also used by scripts/send-test-emails.mjs for local previews).
import {
  FROM_ADDRESS,
  carrierTrackingUrl,
  buildShippingEmail,
} from "./email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// Same "missing key never blocks the actual shipping update" degradation as
// RESEND_API_KEY above -- see createShip24Tracker()'s own comment.
const SHIP24_API_KEY = Deno.env.get("SHIP24_API_KEY");

// Called directly from the browser (admin.html) -- withSupabase() normally
// hands this out for free, but that helper is deliberately not used here
// (see this file's own top comment), so CORS + the OPTIONS preflight are
// handled by hand.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("mark-order-shipped: missing required environment configuration.");
    return json(500, { error: "Not configured." });
  }

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) {
    return json(401, { error: "Missing authorization." });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // auth.getUser(jwt) cryptographically validates the token itself and
  // returns whichever user it belongs to -- no separate RLS-scoped client
  // needed just to answer "who is this." service_role's own profiles
  // lookup right after bypasses RLS entirely (as it always does), which is
  // fine here specifically because THIS lookup's only purpose is deciding
  // is_admin in the first place -- there's no self-referencing policy risk
  // the way supabase/migrations/20260806000100_fix_admin_rls_recursion.sql
  // had to fix for the browser-side RLS path.
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return json(401, { error: "Invalid or expired session." });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("is_admin")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError || !profile?.is_admin) {
    return json(403, { error: "Not authorized." });
  }

  let body: { orderId?: unknown; trackingNumber?: unknown; carrier?: unknown; carrierOtherName?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid request body." });
  }
  const orderId = typeof body.orderId === "string" ? body.orderId : "";
  const trackingNumber = typeof body.trackingNumber === "string" ? body.trackingNumber.trim() : "";
  // Same allow-list as public.orders' own carrier CHECK constraint (see
  // 20260821000000_order_shipping_address_and_carrier.sql) -- re-validated
  // here rather than trusted from the client, same "never trust the browser
  // for anything written to the DB" reasoning as trackingNumber's own
  // required check just below it.
  const ALLOWED_CARRIERS = ["colissimo", "chronopost", "mondial_relay", "autre"];
  const carrier = typeof body.carrier === "string" ? body.carrier.trim() : "";
  if (!orderId || !trackingNumber || !ALLOWED_CARRIERS.includes(carrier)) {
    return json(400, { error: "orderId, trackingNumber, and a valid carrier are required." });
  }
  // Only required/stored for "autre" -- same "never trust the browser"
  // re-validation as carrier/trackingNumber above (js/admin.js's own
  // shipConfirmBtn handler already requires this client-side, but that's
  // only ever a UX convenience, not the real gate). Forced to "" (not
  // whatever the client sent) for every other carrier, so a stale value
  // from an earlier "autre" submission can never linger onto a later
  // correction that switched to a real carrier.
  const carrierOtherName = carrier === "autre" && typeof body.carrierOtherName === "string" ? body.carrierOtherName.trim() : "";
  if (carrier === "autre" && !carrierOtherName) {
    return json(400, { error: "carrierOtherName is required when carrier is \"autre\"." });
  }

  const { data: order, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("id, reference_number, product_name, quantity, total, user_id, guest_email, shipping_status, tracking_number, carrier, carrier_other_name, language, shipping_postal_code")
    .eq("id", orderId)
    .maybeSingle();
  if (orderError || !order) {
    return json(404, { error: "Order not found." });
  }

  const wasAlreadyShipped = order.shipping_status === "shipped";
  // The number, the carrier, OR (for "autre") the typed carrier name
  // changing all count as a real correction -- the same number under a
  // different carrier (or a different name for the same "autre" carrier)
  // still tells the customer something different about their shipment than
  // what they were already told, so it needs the same apologetic re-send as
  // the tracking number itself changing.
  const trackingChanged = order.tracking_number !== trackingNumber
    || order.carrier !== carrier
    || (order.carrier_other_name || "") !== carrierOtherName;
  // First time -> normal shipping notification. Already shipped but
  // something actually changed -> the apologetic correction email instead.
  // Any other case (already shipped, same everything re-submitted -- e.g.
  // an accidental double confirm in the admin UI) -> nothing changed, so
  // nothing to email about; still returns success below, just silently.
  const isCorrection = wasAlreadyShipped && trackingChanged;
  const shouldSendEmail = !wasAlreadyShipped || trackingChanged;

  const { error: updateError } = await supabaseAdmin
    .from("orders")
    .update({
      shipping_status: "shipped",
      tracking_number: trackingNumber,
      carrier,
      // "" (from carrierOtherName's own derivation above) normalized to
      // null for storage -- matches every other optional text column on
      // this table (shipping_address_line2 etc.), never an empty string.
      carrier_other_name: carrierOtherName || null,
      // Reset on every real change (not just the first) -- a correction is
      // its own send attempt with its own success/failure to track, same
      // "false until a confirmed Resend accept" reasoning as email_sent
      // itself (see the migration that added this column).
      ...(shouldSendEmail ? { shipping_email_sent: false } : {}),
      // Set once, on the FIRST transition to shipped only -- a correction
      // (a different tracking number/carrier for an order already marked
      // shipped) changes what the customer was told, not when the order
      // actually left, so it must never overwrite the real original ship
      // date (see 20260829000000_order_shipped_delivered_timestamps.sql's
      // own comment on why this column exists at all).
      ...(!wasAlreadyShipped ? { shipped_at: new Date().toISOString() } : {}),
    })
    .eq("id", orderId);
  if (updateError) {
    console.error("mark-order-shipped: order update failed:", updateError.message);
    return json(500, { error: updateError.message });
  }

  if (shouldSendEmail) {
    // Never lets a Resend failure turn this into a non-2xx response -- the
    // shipping_status/tracking_number update above already committed, and
    // that's the fact that actually matters; a failed notification email is
    // logged + left as shipping_email_sent: false for later follow-up, same
    // as the confirmation email's own graceful-degradation design.
    await sendShippingEmail(supabaseAdmin, order, trackingNumber, carrier, carrierOtherName, isCorrection);
    // Same gate as the email above (first ship OR a real correction) --
    // reusing shouldSendEmail rather than a separate condition: a
    // resubmit-with-nothing-changed has nothing new to track either. A
    // correction with a genuinely different tracking number creates a NEW
    // Ship24 tracker for the new number (see createShip24Tracker()'s own
    // comment on why overwriting ship24_tracker_id here is correct, not a
    // leak of the old one). Never blocks this response -- same
    // graceful-degradation reasoning as the email send just above.
    await createShip24Tracker(supabaseAdmin, order, trackingNumber, carrier);
  }

  return json(200, { ok: true, isCorrection, emailSent: shouldSendEmail });
});

interface OrderRow {
  id: string;
  reference_number: string | null;
  product_name: string;
  quantity: number;
  total: number;
  user_id: string | null;
  guest_email: string | null;
  language: string | null;
  // Needed for Mondial Relay's own tracking link specifically -- see
  // carrierTrackingUrl()'s own comment on why that carrier's tracking page
  // requires the RECIPIENT's postal code alongside the tracking number,
  // unlike Colissimo/Chronopost. Already persisted on this row by
  // stripe-webhook at order-paid time (20260821000000_order_shipping_
  // address_and_carrier.sql) -- read here, not re-typed by the admin.
  shipping_postal_code: string | null;
}

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
      console.error("mark-order-shipped: auth.admin.getUserById failed:", authError.message);
    }
    return { email: authUser?.user?.email || null, firstName: profile?.first_name || "" };
  }
  if (order.guest_email) {
    // No name stored anywhere for a guest order (see the migration's own
    // comment on why the shipping address -- the one place a name briefly
    // passed through -- was deliberately never persisted) -- greeting falls
    // back to the generic form, same as the confirmation email's own
    // extractFirstName() does when it has nothing safe to use.
    return { email: order.guest_email, firstName: "" };
  }
  return { email: null, firstName: "" };
}

async function sendShippingEmail(
  supabaseAdmin: ReturnType<typeof createClient>,
  order: OrderRow,
  trackingNumber: string,
  carrier: string,
  carrierOtherName: string,
  isCorrection: boolean,
) {
  const { email, firstName } = await resolveCustomerEmailAndName(supabaseAdmin, order);
  if (!email) {
    console.error("mark-order-shipped: no resolvable email for order", order.id, "-- notification skipped.");
    return;
  }
  if (!RESEND_API_KEY) {
    console.error("mark-order-shipped: RESEND_API_KEY is not configured -- skipping notification for order", order.id);
    return;
  }

  const language: "fr" | "en" = order.language === "en" ? "en" : "fr"; // matches js/i18n.js's own DEFAULT_LANG = 'fr'
  const { subject, html, text } = buildShippingEmail({
    language,
    firstName,
    referenceNumber: order.reference_number || "",
    productName: order.product_name,
    trackingNumber,
    carrier,
    carrierOtherName,
    postalCode: order.shipping_postal_code || "",
    isCorrection,
  });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [email], subject, html, text }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Resend API responded ${res.status}: ${errBody}`);
    }
    const { error: flagError } = await supabaseAdmin.from("orders").update({ shipping_email_sent: true }).eq("id", order.id);
    if (flagError) {
      console.error("mark-order-shipped: email sent but failed to set shipping_email_sent for order", order.id, ":", flagError.message);
    }
  } catch (err) {
    console.error("mark-order-shipped: notification email failed for order", order.id, ":", err instanceof Error ? err.message : err);
  }
}

// Creates a Ship24 tracker for this shipment (POST /trackers/track -- the
// "create AND get results" endpoint, not the plain /trackers one: this call
// site has no separate need to fetch results synchronously, but the two
// cost the same and this one saves a round trip if results happen to be
// ready immediately). Stores the returned trackerId on the order --
// supabase/functions/ship24-webhook is the only reader, matching a future
// delivery webhook back to this order.
//
// "autre" is deliberately skipped -- it's an admin-typed carrier name, not
// a real courier Ship24 can plausibly auto-detect or track, and the free
// tier's 10-trackers/month quota is too scarce to spend on a shipment
// that's very unlikely to resolve to anything.
//
// courierCode is deliberately NOT passed, even though this project already
// knows which courier (colissimo/chronopost/mondial_relay) was picked --
// Ship24's own documentation recommends omitting it and letting their
// auto-detection run unless a specific code needs to be forced, and this
// project doesn't have a verified courierCode string for any of these
// carriers (Ship24's own courier list is only available via a live
// GET /couriers call or a dashboard CSV export, not published as a static
// reference) -- passing a guessed value risked being silently wrong rather
// than just relying on the documented default behavior.
//
// Never blocks the caller -- same graceful-degradation reasoning as
// sendShippingEmail() just above: a failed/skipped tracker creation means
// no automated delivery detection for this one order, not a failure to
// mark it shipped, which already committed before this function is ever
// called.
async function createShip24Tracker(
  supabaseAdmin: ReturnType<typeof createClient>,
  order: OrderRow,
  trackingNumber: string,
  carrier: string,
) {
  if (carrier === "autre") return;
  if (!SHIP24_API_KEY) {
    console.error("mark-order-shipped: SHIP24_API_KEY is not configured -- skipping Ship24 tracker creation for order", order.id);
    return;
  }
  try {
    const res = await fetch("https://api.ship24.com/public/v1/trackers/track", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SHIP24_API_KEY}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      // orderNumber is purely for Ship24's own dashboard (shown alongside
      // the tracker there) -- not read back by this project, matching
      // reference_number's own role as the customer-facing identifier.
      body: JSON.stringify({ trackingNumber, orderNumber: order.reference_number || order.id }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Ship24 API responded ${res.status}: ${errBody}`);
    }
    const body = await res.json();
    // data.trackings is an array (Ship24 can in principle resolve a single
    // tracking number to more than one leg/courier) -- [0] is the tracker
    // this exact trackingNumber was just created for, always present on a
    // successful response.
    const trackerId = body?.data?.trackings?.[0]?.tracker?.trackerId;
    if (typeof trackerId !== "string" || !trackerId) {
      throw new Error("Ship24 response had no trackerId.");
    }
    const { error: trackerUpdateError } = await supabaseAdmin
      .from("orders")
      .update({ ship24_tracker_id: trackerId })
      .eq("id", order.id);
    if (trackerUpdateError) {
      console.error("mark-order-shipped: tracker created but failed to store ship24_tracker_id for order", order.id, ":", trackerUpdateError.message);
    }
  } catch (err) {
    console.error("mark-order-shipped: Ship24 tracker creation failed for order", order.id, ":", err instanceof Error ? err.message : err);
  }
}
