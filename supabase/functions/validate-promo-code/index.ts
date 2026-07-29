// Server-side promo code validation for checkout.html's Promo Code field
// (js/cart.js's applyPromoCode()). Previously a hardcoded { MONARK10: 0.10 }
// map baked into shipped client-side code -- the discount rate (and the
// fact that any given string was a valid code at all) was trivially
// readable, and forgeable, by anyone with devtools open. This looks the
// code up in public.promo_codes instead, checking active/expires_at/
// max_uses server-side where a client can't tamper with the result.
// supabase/functions/create-checkout-session/index.ts performs the exact
// same check independently when it computes the real charge amount --
// this function never has to be trusted for that, only for the UI's own
// "is this code valid, and what does it look like applied" preview.
//
// auth: "publishable" -- same as check-email-exists/create-checkout-session:
// called straight from the browser (including guests with no session yet),
// gated only by this project's anon/publishable key. ctx.supabase is
// RLS-scoped, which is all this needs -- public.promo_codes has a public
// SELECT policy (see its own migration), the same pattern already used for
// public.products in create-checkout-session. No service-role key anywhere
// in this function.
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

interface RequestBody {
  code?: unknown;
}

export default {
  fetch: withSupabase({ auth: "publishable" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }

    let body: RequestBody;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }

    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    if (!code) {
      return Response.json({ error: "Missing promo code." }, { status: 400 });
    }

    const { data: promo, error } = await ctx.supabase
      .from("promo_codes")
      .select("discount_percent, active, max_uses, times_used, expires_at")
      .eq("code", code)
      .maybeSingle();

    if (error) {
      console.error("validate-promo-code: lookup failed:", error.message);
      return Response.json({ error: "Lookup failed. Please try again." }, { status: 502 });
    }

    // Not found, deactivated, expired, or already at its usage cap --
    // collapsed into one generic { valid: false }, same as the client's own
    // single "Invalid code" message doesn't distinguish why (see
    // checkout.html's checkout.promoInvalid), so this doesn't leak which
    // reason applied to a probing caller either.
    const isValid =
      !!promo &&
      promo.active &&
      (!promo.expires_at || new Date(promo.expires_at) > new Date()) &&
      (promo.max_uses === null || promo.times_used < promo.max_uses);

    if (!isValid) {
      return Response.json({ valid: false });
    }

    return Response.json({ valid: true, discountPercent: promo!.discount_percent });
  }),
};
