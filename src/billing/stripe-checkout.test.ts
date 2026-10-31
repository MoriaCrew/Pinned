import { describe, expect, it } from "vitest";
import { parseConfig } from "../config";
import {
  CreditPriceNotFoundError,
  UnknownCreditPackError,
} from "./checkout";
import { createCreditCheckout } from "./server";
import {
  StripeCreditCheckout,
  type StripeCheckoutSessionParams,
  type StripeClientLike,
  type StripePriceListParams,
} from "./stripe-checkout";

/**
 * Stripe adapter (PIN-149): a fake injected client records every
 * call - no network, no key. The slug sentinel below stands in
 * for a real board slug (a capability secret): it must appear
 * nowhere in anything serialized for Stripe.
 */
const SLUG_SENTINEL = "board-slug-00000000001";
const INTENT_ID = "12345678-1234-4234-8234-1234567890ab";
const PACK = "pinneds_plus_20";

class FakeStripeClient implements StripeClientLike {
  readonly priceLists: StripePriceListParams[] = [];
  readonly sessions: Array<{
    params: StripeCheckoutSessionParams;
    options?: { idempotencyKey?: string };
  }> = [];
  pricesByLookupKey: Record<string, string> = {
    [PACK]: "price_20",
    pinneds_credits_60: "price_60",
  };

  prices = {
    list: async (params: StripePriceListParams) => {
      this.priceLists.push(params);
      const id = this.pricesByLookupKey[params.lookup_keys[0]];
      return { data: id ? [{ id }] : [] };
    },
  };

  checkout = {
    sessions: {
      create: async (
        params: StripeCheckoutSessionParams,
        options?: { idempotencyKey?: string },
      ) => {
        this.sessions.push({ params, options });
        return { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" };
      },
    },
  };
}

function adapter(client: FakeStripeClient, now?: () => number) {
  return new StripeCreditCheckout({ client, priceCacheTtlMs: 60_000, now });
}

describe("StripeCreditCheckout (PIN-149)", () => {
  it("resolves prices by lookup_key and caches them for the TTL", async () => {
    const client = new FakeStripeClient();
    let now = 1_000;
    const checkout = adapter(client, () => now);
    expect(await checkout.resolvePriceId(PACK)).toBe("price_20");
    expect(await checkout.resolvePriceId(PACK)).toBe("price_20");
    expect(client.priceLists).toEqual([
      { lookup_keys: [PACK], active: true, limit: 1 },
    ]);
    now += 59_999;
    await checkout.resolvePriceId(PACK);
    expect(client.priceLists).toHaveLength(1);
    now += 1;
    await checkout.resolvePriceId(PACK);
    expect(client.priceLists).toHaveLength(2);
  });

  it("unknown, draft, retired and mis-sized packs never reach Stripe", async () => {
    const client = new FakeStripeClient();
    const checkout = adapter(client);
    await expect(checkout.resolvePriceId("pinneds_credits_999")).rejects.toBeInstanceOf(
      UnknownCreditPackError,
    );
    // Draft in the catalog (seeded for later, not offered).
    await expect(checkout.resolvePriceId("pinneds_host_monthly")).rejects.toBeInstanceOf(
      UnknownCreditPackError,
    );
    // Retired (PIN-181): refused even while Stripe still has its price.
    await expect(checkout.resolvePriceId("pinneds_credits_60")).rejects.toBeInstanceOf(
      UnknownCreditPackError,
    );
    await expect(
      checkout.createCreditCheckoutSession({
        intentId: INTENT_ID,
        packLookupKey: PACK,
        credits: 21,
        intentExpiresAt: 1_700_001_800_000,
        returnBaseUrl: "https://app.example",
      }),
    ).rejects.toBeInstanceOf(UnknownCreditPackError);
    expect(client.priceLists).toEqual([]);
    expect(client.sessions).toEqual([]);
  });

  it("a catalog pack with no active Stripe price is a typed miss, never cached", async () => {
    const client = new FakeStripeClient();
    client.pricesByLookupKey = {};
    const checkout = adapter(client);
    await expect(checkout.resolvePriceId(PACK)).rejects.toBeInstanceOf(
      CreditPriceNotFoundError,
    );
    await expect(checkout.resolvePriceId(PACK)).rejects.toBeInstanceOf(
      CreditPriceNotFoundError,
    );
    expect(client.priceLists).toHaveLength(2);
  });

  it("creates the exact hosted session: payment, Adaptive Pricing, guest payer, intent-only metadata", async () => {
    const client = new FakeStripeClient();
    const checkout = adapter(client, () => 1_700_000_000_000);
    const session = await checkout.createCreditCheckoutSession({
      intentId: INTENT_ID,
      packLookupKey: PACK,
      credits: 20,
      intentExpiresAt: 1_700_000_000_000 + 1_800_000,
      returnBaseUrl: "https://app.example/",
    });
    expect(session).toEqual({
      url: "https://checkout.stripe.com/c/pay/cs_test_1",
      sessionId: "cs_test_1",
    });
    expect(client.sessions).toHaveLength(1);
    const { params, options } = client.sessions[0];
    expect(params).toEqual({
      mode: "payment",
      line_items: [{ price: "price_20", quantity: 1 }],
      adaptive_pricing: { enabled: true },
      client_reference_id: INTENT_ID,
      metadata: {
        checkout_intent_id: INTENT_ID,
        pack_lookup_key: PACK,
        credits: "20",
      },
      success_url: `https://app.example/billing/return?intent=${INTENT_ID}&result=success`,
      cancel_url: `https://app.example/billing/return?intent=${INTENT_ID}&result=cancel`,
      // Intent TTL is exactly Stripe's 30-minute minimum, so the
      // session expiry floors at 31 minutes (epoch seconds).
      expires_at: 1_700_001_860,
    });
    expect(options).toEqual({ idempotencyKey: `pinned-checkout-intent:${INTENT_ID}` });
    // Dashboard-managed methods + guest default: none of these keys exist.
    for (const key of ["payment_method_types", "customer", "customer_creation", "customer_email"]) {
      expect(params).not.toHaveProperty(key);
    }
    // The capability-secret slug appears nowhere Stripe-facing.
    expect(JSON.stringify({ params, options })).not.toContain(SLUG_SENTINEL);
    expect(params.success_url).not.toContain(SLUG_SENTINEL);
    expect(params.cancel_url).not.toContain(SLUG_SENTINEL);
  });

  it("session expiry tracks a longer intent TTL and caps under 24 hours", async () => {
    const client = new FakeStripeClient();
    const now = 1_700_000_000_000;
    const checkout = adapter(client, () => now);
    await checkout.createCreditCheckoutSession({
      intentId: INTENT_ID,
      packLookupKey: PACK,
      credits: 20,
      intentExpiresAt: now + 2 * 3_600_000,
      returnBaseUrl: "https://app.example",
    });
    expect(client.sessions[0].params.expires_at).toBe((now + 2 * 3_600_000) / 1000);
    await checkout.createCreditCheckoutSession({
      intentId: INTENT_ID,
      packLookupKey: PACK,
      credits: 20,
      intentExpiresAt: now + 48 * 3_600_000,
      returnBaseUrl: "https://app.example",
    });
    expect(client.sessions[1].params.expires_at).toBeLessThan(
      (now + 24 * 3_600_000) / 1000,
    );
  });

  it("createCreditCheckout: null unless stripe mode with a key (fail closed)", () => {
    expect(createCreditCheckout(parseConfig({}))).toBeNull();
    expect(
      createCreditCheckout(parseConfig({ PLUS_MODE: "mock", STRIPE_SECRET_KEY: "rk_test_x" })),
    ).toBeNull();
    expect(createCreditCheckout(parseConfig({ PLUS_MODE: "stripe" }))).toBeNull();
    expect(
      createCreditCheckout(parseConfig({ PLUS_MODE: "stripe", STRIPE_SECRET_KEY: "rk_test_x" })),
    ).toBeInstanceOf(StripeCreditCheckout);
  });
});
