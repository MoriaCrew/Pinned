import { NextResponse } from "next/server";
import { getCheckoutIntentStore } from "../../../server/checkout-intent-store";
import { resolveBillingReturn } from "../../../server/credit-checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe return redirector (PIN-149): the success/cancel URLs
 * Stripe holds carry only the opaque intent id, never the board
 * slug. This handler resolves the intent server-side and 302s
 * to the board with a billing flag. It grants NOTHING - credits
 * arrive by webhook only (PIN-150), so the success flag reads
 * "processing". Unknown/expired intents land on "/" with no
 * flag, indistinguishable from each other.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const resolved = await resolveBillingReturn(
    url.searchParams.get("intent"),
    url.searchParams.get("result"),
    { intents: getCheckoutIntentStore() },
  );
  const response = NextResponse.redirect(new URL(resolved.location, url.origin), 302);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
