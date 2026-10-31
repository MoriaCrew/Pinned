import "server-only";
/**
 * Stripe credit-pack checkout adapter (PIN-149, docs/15).
 * Server-only; the secret key arrives by env name through
 * src/config.ts and is only ever handed to the SDK constructor
 * in src/billing/server.ts - adapters here receive an injected
 * client, so tests run a fake and no test touches the network.
 *
 * Session shape, checked against the current Stripe docs
 * (Checkout Sessions create + Adaptive Pricing, docs.stripe.com):
 * - mode "payment" on the EUR base price, one line item.
 * - adaptive_pricing { enabled: true }: Stripe localizes the
 *   presentment currency; the session still settles in EUR.
 * - NO payment_method_types: that parameter is the legacy static
 *   list; eligible methods are Dashboard-managed (dynamic payment
 *   methods) and naming types would override that configuration.
 * - Guest payer: no `customer`, no `customer_creation` - the
 *   payment-mode default ("if_required") creates no Customer for
 *   a plain one-time payment, so nobody needs an account to pay.
 * - Only the opaque CheckoutIntent id crosses to Stripe:
 *   client_reference_id and metadata carry the intent id plus
 *   the pack lookup key and credits. The board slug (a capability
 *   secret) is never accepted by this adapter, so it cannot leak
 *   into params, metadata or the success/cancel URLs, which go
 *   to the /billing/return redirector keyed by intent id only.
 */
import Stripe from "stripe";
import { findCatalogItem } from "./catalog";
import {
  CreditPriceNotFoundError,
  UnknownCreditPackError,
  type CreditCheckout,
  type CreditCheckoutRequest,
  type CreditCheckoutSession,
} from "./checkout";

/** The slice of the Stripe client this adapter uses (fakeable). */
export interface StripePriceListParams {
  lookup_keys: string[];
  active: boolean;
  limit: number;
}

export interface StripeCheckoutSessionParams {
  mode: "payment";
  line_items: Array<{ price: string; quantity: number }>;
  adaptive_pricing: { enabled: boolean };
  client_reference_id: string;
  metadata: Record<string, string>;
  success_url: string;
  cancel_url: string;
  /** Epoch seconds; Stripe requires 30 minutes to 24 hours out. */
  expires_at: number;
}

export interface StripeClientLike {
  prices: {
    list(
      params: StripePriceListParams,
    ): Promise<{ data: ReadonlyArray<{ id: string }> }>;
  };
  checkout: {
    sessions: {
      create(
        params: StripeCheckoutSessionParams,
        options?: { idempotencyKey?: string },
      ): Promise<{ id: string; url: string | null }>;
    };
  };
}

/**
 * Build the real SDK client. `apiVersion` is typed as the SDK's
 * bundled LatestApiVersion, so bumping the stripe package past
 * the pinned config version (or vice versa) fails typecheck
 * until the two move together.
 */
export function createStripeClient(
  secretKey: string,
  apiVersion: Stripe.LatestApiVersion,
): StripeClientLike {
  return new Stripe(secretKey, { apiVersion, typescript: true });
}

export interface StripeCreditCheckoutDeps {
  client: StripeClientLike;
  /** Price-id cache life; lookup keys are stable across price transfers. */
  priceCacheTtlMs?: number;
  now?: () => number;
}

const DEFAULT_PRICE_CACHE_TTL_MS = 5 * 60_000;

function assertLiveCreditPack(packLookupKey: string, credits?: number): void {
  const item = findCatalogItem(packLookupKey);
  if (
    !item ||
    item.status !== "live" ||
    item.credits === undefined ||
    item.recurring !== undefined ||
    (credits !== undefined && credits !== item.credits)
  ) {
    throw new UnknownCreditPackError(packLookupKey);
  }
}

export class StripeCreditCheckout implements CreditCheckout {
  private readonly priceCache = new Map<
    string,
    { priceId: string; expiresAt: number }
  >();

  constructor(private readonly deps: StripeCreditCheckoutDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async resolvePriceId(packLookupKey: string): Promise<string> {
    assertLiveCreditPack(packLookupKey);
    const cached = this.priceCache.get(packLookupKey);
    if (cached && this.now() < cached.expiresAt) return cached.priceId;
    const page = await this.deps.client.prices.list({
      lookup_keys: [packLookupKey],
      active: true,
      limit: 1,
    });
    const price = page.data[0];
    if (!price) throw new CreditPriceNotFoundError(packLookupKey);
    this.priceCache.set(packLookupKey, {
      priceId: price.id,
      expiresAt:
        this.now() + (this.deps.priceCacheTtlMs ?? DEFAULT_PRICE_CACHE_TTL_MS),
    });
    return price.id;
  }

  async createCreditCheckoutSession(
    request: CreditCheckoutRequest,
  ): Promise<CreditCheckoutSession> {
    assertLiveCreditPack(request.packLookupKey, request.credits);
    const priceId = await this.resolvePriceId(request.packLookupKey);
    const base = request.returnBaseUrl.replace(/\/$/, "");
    // Align the session's death with the intent's: Stripe only
    // accepts 30 minutes to 24 hours out, so floor at 31 minutes
    // (the default intent TTL is exactly 30) and cap under 24h.
    // The intent's cap slot frees at its TTL, so a session that
    // outlived it by a day would let one board hold more open
    // checkouts than its cap. A session paid after the TTL
    // still grants (PIN-178): only Stripe's own expiry closes it.
    const now = this.now();
    const expiresAtMs = Math.min(
      Math.max(request.intentExpiresAt, now + 31 * 60_000),
      now + 23 * 3_600_000 + 59 * 60_000,
    );
    const returnUrl = (result: "success" | "cancel") =>
      `${base}/billing/return?intent=${encodeURIComponent(request.intentId)}&result=${result}`;
    const session = await this.deps.client.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [{ price: priceId, quantity: 1 }],
        adaptive_pricing: { enabled: true },
        client_reference_id: request.intentId,
        metadata: {
          checkout_intent_id: request.intentId,
          pack_lookup_key: request.packLookupKey,
          credits: String(request.credits),
        },
        success_url: returnUrl("success"),
        cancel_url: returnUrl("cancel"),
        expires_at: Math.floor(expiresAtMs / 1000),
      },
      { idempotencyKey: `pinned-checkout-intent:${request.intentId}` },
    );
    if (!session.url) {
      throw new Error("Stripe Checkout Session came back without a URL.");
    }
    return { url: session.url, sessionId: session.id };
  }
}
