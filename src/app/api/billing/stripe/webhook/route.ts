import { NextResponse } from "next/server";
import { getStripeWebhookClient } from "../../../../../billing/server";
import { getConfig } from "../../../../../config";
import { getPolicy } from "../../../../../policy/server";
import { getBoardRepository } from "../../../../../server/board-repository";
import { getCheckoutIntentStore } from "../../../../../server/checkout-intent-store";
import { getCreditLedgerStore } from "../../../../../server/credit-ledger-store";
import {
  StripeWebhookConfigError,
  StripeWebhookSignatureError,
  handleStripeWebhook,
} from "../../../../../server/stripe-webhook";
import { getStripeWebhookRecordStore } from "../../../../../server/stripe-webhook-records-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe webhook (PIN-150): the raw request body goes to the
 * signature check untouched - no JSON parsing, no cross-site
 * or session guards (Stripe is not a browser; the signature
 * is the authentication). 200 for every handled decision
 * (processed, duplicate, dead-lettered, unhandled type);
 * 400 only for a bad/missing signature; 503 fail-closed when
 * stripe mode, the API key, or STRIPE_WEBHOOK_SECRET is
 * absent; 500 for unexpected failures so Stripe retries.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const config = getConfig();
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  try {
    await handleStripeWebhook(rawBody, signature, {
      plusMode: config.plusMode,
      webhookSecret: config.stripeWebhookSecret,
      client: getStripeWebhookClient(),
      intents: getCheckoutIntentStore(),
      ledger: getCreditLedgerStore(),
      records: getStripeWebhookRecordStore(),
      boards: getBoardRepository(),
      policy: getPolicy(),
      resolvePolicyForBoard: async (boardId) => {
        const board = await getBoardRepository().getBoard(boardId);
        return getPolicy(board?.policyOverrides ?? null);
      },
    });
    return NextResponse.json({ received: true });
  } catch (error) {
    if (error instanceof StripeWebhookConfigError) {
      return NextResponse.json({ error: "webhook_unavailable" }, { status: 503 });
    }
    if (error instanceof StripeWebhookSignatureError) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
    }
    console.error(
      "Stripe webhook handling failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json({ error: "webhook_failed" }, { status: 500 });
  }
}
