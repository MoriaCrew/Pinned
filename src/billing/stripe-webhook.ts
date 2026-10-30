import "server-only";
/**
 * Stripe webhook client adapter (PIN-150, docs/15).
 * Server-only; the secret key arrives by env name through
 * src/config.ts and is only ever handed to the SDK constructor
 * in src/billing/server.ts - the webhook service receives an
 * injected client shaped like `StripeWebhookClientLike`, so
 * tests verify real signatures with the SDK's own test-header
 * signer and fake only the retrieval calls (no network).
 *
 * Signature verification is the SDK's `webhooks.constructEvent`
 * over the RAW body (docs.stripe.com/webhooks): it recomputes
 * the HMAC from the `Stripe-Signature` header + endpoint secret
 * and throws on any mismatch or stale timestamp. Anything that
 * only parses JSON would accept forged grants, so there is no
 * fallback path here.
 *
 * Retrievals exist for the two documented snapshot gaps:
 * Checkout fulfilment retrieves the session when the event
 * snapshot lacks payment/amount fields, and settled-EUR amounts
 * for foreign-presentment refunds/disputes come from the
 * BalanceTransaction (`amount`/`currency` are in the account's
 * settlement currency, with `exchange_rate` to the charge
 * currency) reached via the charge / payment intent.
 */
import Stripe from "stripe";

/** The slice of the Stripe client the webhook uses (fakeable). Returned objects are read structurally by the service. */
export interface StripeWebhookClientLike {
  constructEvent(rawBody: string, signature: string, secret: string): unknown;
  retrieveCheckoutSession(sessionId: string): Promise<unknown>;
  retrievePaymentIntent(paymentIntentId: string): Promise<unknown>;
  retrieveCharge(chargeId: string): Promise<unknown>;
  retrieveBalanceTransaction(balanceTransactionId: string): Promise<unknown>;
}

/** Build the real SDK-backed webhook client, API version pinned in config like the checkout adapter. */
export function createStripeWebhookSdkClient(
  secretKey: string,
  apiVersion: Stripe.LatestApiVersion,
): StripeWebhookClientLike {
  const stripe = new Stripe(secretKey, { apiVersion, typescript: true });
  return {
    constructEvent: (rawBody, signature, secret) =>
      stripe.webhooks.constructEvent(rawBody, signature, secret),
    retrieveCheckoutSession: (sessionId) =>
      stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent.latest_charge"],
      }),
    retrievePaymentIntent: (paymentIntentId) =>
      stripe.paymentIntents.retrieve(paymentIntentId),
    retrieveCharge: (chargeId) => stripe.charges.retrieve(chargeId),
    retrieveBalanceTransaction: (balanceTransactionId) =>
      stripe.balanceTransactions.retrieve(balanceTransactionId),
  };
}
