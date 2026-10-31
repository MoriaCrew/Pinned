import Stripe from "stripe";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Stripe webhook route (PIN-150), stripe mode on the memory
 * backends: proves the wire contract around the service -
 * raw-body signature 400s, 200 { received: true } for handled
 * decisions, and one end-to-end paid grant through the real
 * route + global stores. The session carries an expanded
 * payment_intent so the grant needs no Stripe retrieval (the
 * service tests fake those calls). All ids/keys are fake.
 * Env is set before the route modules first read config
 * (dynamic imports, like the plus route tests).
 */
process.env.PLUS_MODE = "stripe";
process.env.AI_MOCK = "1";
process.env.DATA_BACKEND = "memory";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_route_key";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake_route_secret";

const SECRET = "whsec_test_fake_route_secret";
const sdk = new Stripe("sk_test_fake_route_key");

let webhookRoute: (request: Request) => Promise<Response>;
let intentId: string;
let slug: string;
let ledgerBalance: () => Promise<{ balance: number }>;
let boardPlus: () => Promise<unknown>;

beforeAll(async () => {
  ({ POST: webhookRoute } = await import("./stripe/webhook/route"));
  const { getBoardRepository } = await import("../../../server/board-repository");
  const { CONTRACT_SLUG, seedBoard } = await import(
    "../../../billing/mock-checkout.contract"
  );
  slug = CONTRACT_SLUG;
  await seedBoard(getBoardRepository());
  const { getCheckoutIntentStore } = await import(
    "../../../server/checkout-intent-store"
  );
  const { getCreditLedgerStore } = await import(
    "../../../server/credit-ledger-store"
  );
  const intent = await getCheckoutIntentStore().create({
    boardId: slug,
    packLookupKey: "pinneds_plus_20",
    credits: 20,
    eurCents: 299,
    at: Date.now(),
    intentTtlSeconds: 1_800,
    pendingIntentCapPerBoard: 3,
  });
  intentId = intent.id;
  await getCreditLedgerStore().recordPurchase(slug, {
    purchaseId: intent.purchaseId,
    credits: 20,
  });
  ledgerBalance = () => getCreditLedgerStore().getBalance(slug);
  boardPlus = async () => (await getBoardRepository().getBoard(slug))?.plus ?? null;
});

function signedPost(event: unknown, secret = SECRET): Promise<Response> {
  const payload = JSON.stringify(event);
  const header = sdk.webhooks.generateTestHeaderString({ payload, secret });
  return webhookRoute(
    new Request("http://t/api/billing/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": header, "content-type": "application/json" },
      body: payload,
    }),
  );
}

function paidSessionEvent(eventId: string) {
  return {
    id: eventId,
    object: "event",
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: "cs_test_fake_route",
        object: "checkout.session",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_total: 299,
        currency: "eur",
        client_reference_id: intentId,
        metadata: {
          checkout_intent_id: intentId,
          pack_lookup_key: "pinneds_plus_20",
          credits: "20",
        },
        payment_intent: { id: "pi_test_fake_route", latest_charge: "ch_test_fake_route" },
      },
    },
  };
}

describe("POST /api/billing/stripe/webhook (stripe mode, PIN-150)", () => {
  it("rejects a bad signature and a missing header with 400 before any grant", async () => {
    const bad = await signedPost(paidSessionEvent("evt_route_bad"), "whsec_test_wrong");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_signature" });
    const missing = await webhookRoute(
      new Request("http://t/api/billing/stripe/webhook", { method: "POST", body: "{}" }),
    );
    expect(missing.status).toBe(400);
    expect(await ledgerBalance()).toMatchObject({ balance: 0 });
  });

  it("grants a paid session end-to-end with 200, and a replay stays at one grant", async () => {
    const event = paidSessionEvent("evt_route_paid");
    const res = await signedPost(event);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(await ledgerBalance()).toMatchObject({ balance: 20 });
    // PIN-181: the purchase also gave the board paid Plus.
    expect(await boardPlus()).toMatchObject({ plan: "board", source: "stripe" });
    const replay = await signedPost(event);
    expect(replay.status).toBe(200);
    expect(await ledgerBalance()).toMatchObject({ balance: 20 });
  });

  it("refuses a declared body over 1 MiB with 413 before reading it (PIN-178)", async () => {
    const res = await webhookRoute(
      new Request("http://t/api/billing/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=fake", "content-length": String(1_048_577) },
        body: "{}",
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body_too_large" });
  });

  it("logs an unexpected failure slug-redacted and answers 500 (PIN-178)", async () => {
    const { getCreditLedgerStore } = await import("../../../server/credit-ledger-store");
    const ledger = getCreditLedgerStore();
    const realGetAccount = ledger.getAccount.bind(ledger);
    ledger.getAccount = async () => {
      throw new Error(`Board ${slug} store unavailable`);
    };
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const res = await signedPost(paidSessionEvent("evt_route_store_down"));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "webhook_failed" });
    } finally {
      console.error = realError;
      ledger.getAccount = realGetAccount;
    }
    const text = JSON.stringify(logged);
    expect(text).toContain("Stripe webhook handling failed");
    expect(text).toContain("<slug>");
    expect(text).not.toContain(slug);
  });

  it("acks an unhandled event type with 200", async () => {
    const res = await signedPost({
      id: "evt_route_other",
      object: "event",
      type: "payment_intent.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "pi_test_fake_route" } },
    });
    expect(res.status).toBe(200);
  });
});
