import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import type { StripeWebhookClientLike } from "../billing/stripe-webhook";
import { CONTRACT_SLUG as SLUG, seedBoard } from "../billing/mock-checkout.contract";
import { STRIPE_API_VERSION } from "../config";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { InMemoryCreditLedgerStore } from "../domain/credit-ledger";
import { resolvePolicy, DEFAULT_POLICY } from "../policy/policy";
import { InMemoryCheckoutIntentStore, type CheckoutIntent } from "./checkout-intent";
import { resolveBillingReturn } from "./credit-checkout";
import {
  StripeWebhookConfigError,
  StripeWebhookSignatureError,
  handleStripeWebhook,
  makesFloorForCents,
  makesFreezeForCents,
  STRIPE_WEBHOOK_EVENT_TYPES,
  type StripeWebhookDeps,
} from "./stripe-webhook";
import { InMemoryStripeWebhookRecordStore } from "./stripe-webhook-records";

/**
 * Webhook service (PIN-150): payloads are signed with the real
 * SDK's test-header signer and verified by the real
 * `constructEvent`; only the retrieval calls are faked, so no
 * network and no real keys. All Stripe ids below are obviously
 * fake test ids. NOW tracks the wall clock (second precision)
 * because SDK signature verification applies a timestamp
 * tolerance to the generated header.
 */
const SECRET = "whsec_test_fake_signing_secret";
const NOW = Math.floor(Date.now() / 1000) * 1000;
const PACK = "pinneds_credits_25";
/** Test-local pack on the retired 25-make terms: the handler is pack-agnostic (the shipped default is pinned below and in policy.test.ts). */
const TEST_PACK = { lookupKey: PACK, credits: 25, eurCents: 499, label: "25 makes" };
const SESSION_ID = "cs_test_fake_1";
const PAYMENT_INTENT_ID = "pi_test_fake_1";
const CHARGE_ID = "ch_test_fake_1";
const sdk = new Stripe("sk_test_fake", { apiVersion: STRIPE_API_VERSION });

class FakeWebhookClient implements StripeWebhookClientLike {
  readonly retrievedSessions: string[] = [];
  readonly retrievedPaymentIntents: string[] = [];
  sessions: Record<string, unknown> = {};
  sessionsByPaymentIntent: Record<string, unknown> = {};
  paymentIntents: Record<string, unknown> = {
    [PAYMENT_INTENT_ID]: { id: PAYMENT_INTENT_ID, latest_charge: CHARGE_ID },
  };
  charges: Record<string, unknown> = {
    [CHARGE_ID]: { id: CHARGE_ID, balance_transaction: "txn_test_fake_charge" },
  };
  balanceTransactions: Record<string, unknown> = {
    txn_test_fake_charge: { id: "txn_test_fake_charge", amount: 499, currency: "eur" },
    txn_test_fake_refund_eur: { id: "txn_test_fake_refund_eur", amount: -499, currency: "eur" },
  };

  constructEvent(rawBody: string, signature: string, secret: string): unknown {
    return sdk.webhooks.constructEvent(rawBody, signature, secret);
  }
  async retrieveCheckoutSession(sessionId: string): Promise<unknown> {
    this.retrievedSessions.push(sessionId);
    return this.sessions[sessionId] ?? null;
  }
  async retrievePaymentIntent(paymentIntentId: string): Promise<unknown> {
    this.retrievedPaymentIntents.push(paymentIntentId);
    return this.paymentIntents[paymentIntentId] ?? null;
  }
  async findCheckoutSessionByPaymentIntent(paymentIntentId: string): Promise<unknown> {
    return this.sessionsByPaymentIntent[paymentIntentId] ?? null;
  }
  async retrieveCharge(chargeId: string): Promise<unknown> {
    return this.charges[chargeId] ?? null;
  }
  async retrieveBalanceTransaction(id: string): Promise<unknown> {
    return this.balanceTransactions[id] ?? null;
  }
}

async function harness() {
  const boards = new InMemoryBoardRepository();
  await seedBoard(boards);
  const intents = new InMemoryCheckoutIntentStore();
  const ledger = new InMemoryCreditLedgerStore();
  const records = new InMemoryStripeWebhookRecordStore();
  const client = new FakeWebhookClient();
  let nowMs = NOW;
  const deps: StripeWebhookDeps = {
    plusMode: "stripe",
    webhookSecret: SECRET,
    client,
    intents,
    ledger,
    records,
    boards,
    policy: resolvePolicy({ credits: { packs: [TEST_PACK] } }),
    now: () => nowMs,
  };
  async function createIntent(): Promise<CheckoutIntent> {
    const intent = await intents.create({
      boardId: SLUG,
      packLookupKey: PACK,
      credits: 25,
      eurCents: 499,
      at: NOW,
      intentTtlSeconds: 1_800,
      pendingIntentCapPerBoard: 10,
    });
    await ledger.recordPurchase(SLUG, { purchaseId: intent.purchaseId, credits: 25 });
    return intent;
  }
  async function deliver(event: unknown, secret = SECRET) {
    const payload = JSON.stringify(event);
    const header = sdk.webhooks.generateTestHeaderString({ payload, secret });
    return handleStripeWebhook(payload, header, deps);
  }
  return {
    boards,
    intents,
    ledger,
    records,
    client,
    deps,
    createIntent,
    deliver,
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

function evt(id: string, type: string, object: unknown, atMs = NOW + 60_000) {
  return { id, object: "event", type, created: Math.floor(atMs / 1000), data: { object } };
}

function session(intentId: string, over: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    amount_total: 499,
    currency: "eur",
    client_reference_id: intentId,
    metadata: { checkout_intent_id: intentId, pack_lookup_key: PACK, credits: "25" },
    payment_intent: PAYMENT_INTENT_ID,
    ...over,
  };
}

function refund(over: Record<string, unknown> = {}) {
  return {
    id: "re_test_fake_1",
    object: "refund",
    amount: 499,
    currency: "eur",
    status: "succeeded",
    charge: CHARGE_ID,
    payment_intent: PAYMENT_INTENT_ID,
    ...over,
  };
}

function dispute(over: Record<string, unknown> = {}) {
  return {
    id: "du_test_fake_1",
    object: "dispute",
    amount: 499,
    currency: "eur",
    status: "needs_response",
    charge: CHARGE_ID,
    payment_intent: PAYMENT_INTENT_ID,
    balance_transactions: [],
    ...over,
  };
}

describe("money -> makes formula (PIN-150)", () => {
  const pack = TEST_PACK;
  it("floor for clawbacks, ceil for freezes, capped at the pack", () => {
    // The shipped pack (PIN-181): 20 makes for 299 cents.
    const shipped = DEFAULT_POLICY.credits.packs[0];
    expect(shipped).toMatchObject({ credits: 20, eurCents: 299 });
    expect([makesFloorForCents(299, shipped), makesFloorForCents(150, shipped)]).toEqual([20, 10]);
    expect([makesFreezeForCents(150, shipped), makesFreezeForCents(1, shipped)]).toEqual([11, 1]);
    expect(makesFloorForCents(499, pack)).toBe(25);
    expect(makesFloorForCents(250, pack)).toBe(12);
    expect(makesFloorForCents(10, pack)).toBe(0);
    expect(makesFloorForCents(99_999, pack)).toBe(25);
    expect(makesFreezeForCents(499, pack)).toBe(25);
    expect(makesFreezeForCents(250, pack)).toBe(13);
    expect(makesFreezeForCents(10, pack)).toBe(1);
    expect(makesFreezeForCents(99_999, pack)).toBe(25);
  });

  it("registers exactly the handled event list for PIN-153", () => {
    expect(STRIPE_WEBHOOK_EVENT_TYPES).toEqual([
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
      "refund.created",
      "refund.updated",
      "refund.failed",
      "charge.dispute.created",
      "charge.dispute.funds_withdrawn",
      "charge.dispute.funds_reinstated",
      "charge.dispute.closed",
    ]);
  });
});

describe("handleStripeWebhook gates (PIN-150)", () => {
  it("missing secret, off mode, and a missing client fail closed before any parsing", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    const payload = JSON.stringify(evt("evt_cfg", "checkout.session.completed", session(intent.id)));
    const header = sdk.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    await expect(
      handleStripeWebhook(payload, header, { ...h.deps, webhookSecret: null }),
    ).rejects.toBeInstanceOf(StripeWebhookConfigError);
    await expect(
      handleStripeWebhook(payload, header, { ...h.deps, plusMode: "off" }),
    ).rejects.toBeInstanceOf(StripeWebhookConfigError);
    await expect(
      handleStripeWebhook(payload, header, { ...h.deps, plusMode: "mock" }),
    ).rejects.toBeInstanceOf(StripeWebhookConfigError);
    await expect(
      handleStripeWebhook(payload, header, { ...h.deps, client: null }),
    ).rejects.toBeInstanceOf(StripeWebhookConfigError);
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0 });
  });

  it("a bad signature and a missing header are rejected and grant nothing", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    const event = evt("evt_sig", "checkout.session.completed", session(intent.id));
    await expect(h.deliver(event, "whsec_test_wrong_secret")).rejects.toBeInstanceOf(
      StripeWebhookSignatureError,
    );
    await expect(handleStripeWebhook(JSON.stringify(event), null, h.deps)).rejects.toBeInstanceOf(
      StripeWebhookSignatureError,
    );
    // A body tampered after signing fails too.
    const payload = JSON.stringify(event);
    const header = sdk.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    const tampered = payload.replace("499", "1");
    await expect(handleStripeWebhook(tampered, header, h.deps)).rejects.toBeInstanceOf(
      StripeWebhookSignatureError,
    );
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0 });
    expect(await h.records.getProcessed("evt_sig")).toBeNull();
  });

  it("unhandled event types are acked, recorded once, and touch nothing", async () => {
    const h = await harness();
    const event = evt("evt_other", "payment_intent.succeeded", { id: PAYMENT_INTENT_ID });
    expect(await h.deliver(event)).toEqual({
      eventId: "evt_other",
      outcome: "unhandled",
      duplicate: false,
    });
    expect(await h.deliver(event)).toMatchObject({ outcome: "duplicate", duplicate: true });
  });
});

describe("checkout fulfilment (PIN-150)", () => {
  it("an unpaid completed grants nothing but persists the session mapping", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    const result = await h.deliver(
      evt("evt_unpaid", "checkout.session.completed", session(intent.id, { payment_status: "unpaid" })),
    );
    expect(result.outcome).toBe("ignored_unpaid");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0, available: 0 });
    expect(await h.ledger.listEntries(SLUG)).toEqual([]);
    expect(await h.intents.get(intent.id)).toMatchObject({
      status: "pending",
      stripeSessionId: SESSION_ID,
      stripePaymentIntentId: PAYMENT_INTENT_ID,
    });
  });

  it("paid completed grants exactly once: duplicate delivery and async success stay at one grant", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    const completed = evt("evt_paid", "checkout.session.completed", session(intent.id));
    expect((await h.deliver(completed)).outcome).toBe("granted");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, available: 25 });
    // Mapping persisted at grant time, charge resolved via the PaymentIntent.
    expect(h.client.retrievedPaymentIntents).toEqual([PAYMENT_INTENT_ID]);
    expect(await h.intents.get(intent.id)).toMatchObject({
      status: "closed",
      stripeSessionId: SESSION_ID,
      stripePaymentIntentId: PAYMENT_INTENT_ID,
      stripeChargeId: CHARGE_ID,
      grantedAt: NOW + 60_000,
    });
    expect(await h.intents.findByStripeIds({ chargeId: CHARGE_ID })).toMatchObject({
      id: intent.id,
    });
    // Same event replayed (durable processed record) + the async twin event.
    expect(await h.deliver(completed)).toMatchObject({ duplicate: true });
    expect(
      (await h.deliver(evt("evt_async", "checkout.session.async_payment_succeeded", session(intent.id))))
        .outcome,
    ).toBe("duplicate_grant");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25 });
    expect(await h.ledger.listEntries(SLUG)).toHaveLength(1);
  });

  it("grants from a retrieved session when the snapshot lacks payment/amount fields", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    h.client.sessions[SESSION_ID] = session(intent.id);
    const thin = {
      id: SESSION_ID,
      object: "checkout.session",
      client_reference_id: intent.id,
      metadata: { checkout_intent_id: intent.id, pack_lookup_key: PACK, credits: "25" },
    };
    expect(
      (await h.deliver(evt("evt_thin", "checkout.session.completed", thin))).outcome,
    ).toBe("granted");
    expect(h.client.retrievedSessions).toEqual([SESSION_ID]);
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25 });
  });

  it("amount mismatch and unknown intents dead-letter with 200 semantics and no grant", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    expect(
      (await h.deliver(
        evt("evt_mismatch", "checkout.session.completed", session(intent.id, { amount_total: 498 })),
      )).outcome,
    ).toBe("dead_letter");
    expect(
      (await h.deliver(
        evt("evt_unknown", "checkout.session.completed", session("00000000-0000-4000-8000-000000000000")),
      )).outcome,
    ).toBe("dead_letter");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0 });
    const dead = await h.records.listDeadLetters();
    expect(dead.map((d) => d.reason).sort()).toEqual(["amount_mismatch", "unknown_intent"]);
    expect(dead.every((d) => d.operatorFlag)).toBe(true);
    expect(dead.find((d) => d.reason === "amount_mismatch")).toMatchObject({
      intentId: intent.id,
      eventId: "evt_mismatch",
    });
    // The real paid event still grants afterwards.
    expect(
      (await h.deliver(evt("evt_real", "checkout.session.completed", session(intent.id)))).outcome,
    ).toBe("granted");
  });


  it("async_payment_failed and expired close the intent and purchase without granting", async () => {
    const h = await harness();
    const failed = await h.createIntent();
    expect(
      (await h.deliver(
        evt("evt_failed", "checkout.session.async_payment_failed", session(failed.id, { payment_status: "unpaid" })),
      )).outcome,
    ).toBe("closed");
    expect(await h.intents.get(failed.id)).toMatchObject({ status: "closed" });
    const accountAfterFail = await h.ledger.getAccount(SLUG);
    expect(accountAfterFail?.purchases[failed.id]).toMatchObject({ state: "closed" });

    const expired = await h.createIntent();
    expect(
      (await h.deliver(
        evt("evt_expired", "checkout.session.expired", session(expired.id, { payment_status: "unpaid", status: "expired" }), NOW + 1_800_000),
      )).outcome,
    ).toBe("closed");
    expect(await h.intents.get(expired.id)).toMatchObject({ status: "expired" });
    const account = await h.ledger.getAccount(SLUG);
    expect(account?.purchases[expired.id]).toMatchObject({ state: "closed" });
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0 });
    expect(await h.ledger.listEntries(SLUG)).toEqual([]);
  });
});

describe("paid sessions past the intent TTL (PIN-178)", () => {
  const TTL_MS = 1_800_000;

  it("a paid completed at 30:30 after the intent was created grants", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    h.setNow(NOW + TTL_MS + 30_000);
    const late = evt("evt_late", "checkout.session.completed", session(intent.id), NOW + TTL_MS + 30_000);
    expect((await h.deliver(late)).outcome).toBe("granted");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, available: 25 });
    expect(await h.intents.get(intent.id)).toMatchObject({ status: "closed" });
    expect(await h.records.listDeadLetters()).toEqual([]);
  });

  it("the return redirect landing first changes nothing, then the paid webhook grants", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    const returnAt = NOW + TTL_MS + 20_000;
    // Past the TTL the redirect answers generically, and writes nothing.
    expect(
      await resolveBillingReturn(intent.id, "success", { intents: h.intents, now: () => returnAt }),
    ).toEqual({ kind: "generic", location: "/" });
    expect(await h.intents.get(intent.id)).toEqual(intent);
    expect(
      (await h.deliver(
        evt("evt_after_return", "checkout.session.completed", session(intent.id), NOW + TTL_MS + 30_000),
      )).outcome,
    ).toBe("granted");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25 });
    // Granted (closed) intents return to their board again.
    expect(
      await resolveBillingReturn(intent.id, "success", { intents: h.intents, now: () => returnAt }),
    ).toEqual({ kind: "board", location: `/g/${SLUG}?billing=processing` });
  });

  it("a cap check that lazily expired the intent frees its slot, and the paid webhook still grants", async () => {
    const h = await harness();
    const capInput = {
      boardId: SLUG,
      packLookupKey: PACK,
      credits: 25,
      eurCents: 499,
      intentTtlSeconds: 1_800,
      pendingIntentCapPerBoard: 1,
    };
    const first = await h.intents.create({ ...capInput, at: NOW });
    await h.ledger.recordPurchase(SLUG, { purchaseId: first.purchaseId, credits: 25 });
    // A second buy on the same board after the TTL: the cap check
    // expires `first` and the board gets its one slot back.
    const second = await h.intents.create({ ...capInput, at: NOW + TTL_MS + 10_000 });
    expect(second.status).toBe("pending");
    expect(await h.intents.get(first.id)).toMatchObject({ status: "expired" });
    const account = await h.ledger.getAccount(SLUG);
    expect(account?.purchases[first.id]).toMatchObject({ state: "pending" });

    expect(
      (await h.deliver(
        evt("evt_after_cap", "checkout.session.completed", session(first.id), NOW + TTL_MS + 30_000),
      )).outcome,
    ).toBe("granted");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25 });
    expect(await h.intents.get(first.id)).toMatchObject({ status: "closed" });
    // The freed slot stays with `second`: the cap is still full.
    await expect(
      h.intents.create({ ...capInput, at: NOW + TTL_MS + 40_000 }),
    ).rejects.toThrow(RangeError);
    expect(await h.records.listDeadLetters()).toEqual([]);
  });

  it("async_payment_succeeded two days after creation grants", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    expect(
      (await h.deliver(
        evt("evt_async_pending", "checkout.session.completed", session(intent.id, { payment_status: "unpaid" })),
      )).outcome,
    ).toBe("ignored_unpaid");
    const twoDays = NOW + 2 * 86_400_000;
    h.setNow(twoDays);
    expect(
      (await h.deliver(
        evt("evt_async_paid", "checkout.session.async_payment_succeeded", session(intent.id), twoDays),
      )).outcome,
    ).toBe("granted");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25 });
    expect(await h.intents.get(intent.id)).toMatchObject({ status: "closed", grantedAt: twoDays });
  });

  it("a paid event after Stripe expired the session dead-letters dead_intent and grants nothing", async () => {
    // Stripe cannot report one session both expired and paid; if it
    // ever did, the terminal `expired` already closed the purchase.
    const h = await harness();
    const intent = await h.createIntent();
    expect(
      (await h.deliver(
        evt("evt_expired", "checkout.session.expired", session(intent.id, { payment_status: "unpaid", status: "expired" }), NOW + TTL_MS + 60_000),
      )).outcome,
    ).toBe("closed");
    expect(
      (await h.deliver(
        evt("evt_paid_after_expired", "checkout.session.completed", session(intent.id), NOW + TTL_MS + 90_000),
      )).outcome,
    ).toBe("dead_letter");
    expect((await h.records.listDeadLetters()).map((d) => d.reason)).toEqual(["dead_intent"]);
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0 });
    const account = await h.ledger.getAccount(SLUG);
    expect(account?.purchases[intent.id]).toMatchObject({ state: "closed", grantedCredits: 0 });
  });
});

describe("refunds (PIN-150)", () => {
  async function granted() {
    const h = await harness();
    const intent = await h.createIntent();
    await h.deliver(evt("evt_paid", "checkout.session.completed", session(intent.id)));
    return { h, intent };
  }

  it("two partial refunds sum to the full pack with no drift; a duplicate refund id is a no-op", async () => {
    const { h, intent } = await granted();
    expect(
      (await h.deliver(evt("evt_re1", "refund.created", refund({ id: "re_test_fake_a", amount: 250 })))).outcome,
    ).toBe("refund_clawed");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 13 });
    // Same refund id under a new event id (created + updated both delivered).
    expect(
      (await h.deliver(evt("evt_re1b", "refund.updated", refund({ id: "re_test_fake_a", amount: 250 })))).outcome,
    ).toBe("duplicate_refund");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 13 });
    expect(
      (await h.deliver(evt("evt_re2", "refund.created", refund({ id: "re_test_fake_b", amount: 249 })))).outcome,
    ).toBe("refund_clawed");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0, available: 0 });
    expect(await h.intents.get(intent.id)).toMatchObject({
      refundedEurCents: 499,
      refundClawedMakes: 25,
      countedRefundIds: ["re_test_fake_a", "re_test_fake_b"],
    });
  });

  it("concurrent partial refunds still sum to the full pack (atomic count, no snapshot pricing)", async () => {
    const { h, intent } = await granted();
    const outcomes = await Promise.all([
      h.deliver(evt("evt_re_a", "refund.created", refund({ id: "re_test_fake_a", amount: 250 }))),
      h.deliver(evt("evt_re_b", "refund.created", refund({ id: "re_test_fake_b", amount: 249 }))),
    ]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["refund_clawed", "refund_clawed"]);
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0, available: 0 });
    expect(await h.intents.get(intent.id)).toMatchObject({
      refundedEurCents: 499,
      refundClawedMakes: 25,
    });
    const clawedTotal = (await h.ledger.listEntries(SLUG))
      .filter((e) => e.type === "clawback")
      .reduce((sum, e) => sum + e.amount, 0);
    expect(clawedTotal).toBe(25);
  });

  it("a sub-make refund records its cents (zero makes) so the next partial sums correctly", async () => {
    const { h } = await granted();
    expect(
      (await h.deliver(evt("evt_tiny", "refund.created", refund({ id: "re_test_fake_tiny", amount: 10 })))).outcome,
    ).toBe("refund_recorded_zero_makes");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25 });
    expect(
      (await h.deliver(evt("evt_rest", "refund.created", refund({ id: "re_test_fake_rest", amount: 489 })))).outcome,
    ).toBe("refund_clawed");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0 });
  });

  it("a pending refund waits; only succeeded (via refund.updated) claws back", async () => {
    const { h } = await granted();
    expect(
      (await h.deliver(evt("evt_pend", "refund.created", refund({ status: "pending" })))).outcome,
    ).toBe("refund_ignored_status");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25 });
    expect(
      (await h.deliver(evt("evt_settled", "refund.updated", refund({ status: "succeeded" })))).outcome,
    ).toBe("refund_clawed");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0 });
    expect(
      (await h.deliver(evt("evt_failed_re", "refund.failed", refund({ id: "re_test_fake_x", status: "failed" })))).outcome,
    ).toBe("refund_ignored_status");
  });

  it("refund-before-grant nets to exactly zero at grant time", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    // Session ids already known (an earlier session event), refund lands first.
    await h.intents.recordStripeMapping(
      intent.id,
      { sessionId: SESSION_ID, paymentIntentId: PAYMENT_INTENT_ID, chargeId: CHARGE_ID },
      NOW,
    );
    expect((await h.deliver(evt("evt_re_first", "refund.created", refund()))).outcome).toBe(
      "refund_clawed",
    );
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0 });
    expect(
      (await h.deliver(evt("evt_paid_late", "checkout.session.completed", session(intent.id)))).outcome,
    ).toBe("granted");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0, available: 0 });
    const account = await h.ledger.getAccount(SLUG);
    expect(account?.purchases[intent.id]).toMatchObject({ state: "clawed_back", clawedCredits: 25 });
  });

  it("a foreign-presentment refund claws back by its settled EUR BalanceTransaction", async () => {
    const { h } = await granted();
    expect(
      (await h.deliver(
        evt("evt_fx", "refund.created", refund({
          currency: "usd",
          amount: 540,
          balance_transaction: "txn_test_fake_refund_eur",
        })),
      )).outcome,
    ).toBe("refund_clawed");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0 });
  });

  it("unknown-mapping refunds and unverifiable FX dead-letter with no clawback", async () => {
    const { h } = await granted();
    expect(
      (await h.deliver(evt("evt_no_map", "refund.created", refund({ id: "re_test_fake_orphan", charge: "ch_test_unknown", payment_intent: "pi_test_unknown" })))).outcome,
    ).toBe("dead_letter");
    expect(
      (await h.deliver(
        evt("evt_no_fx", "refund.created", refund({ id: "re_test_fake_fx", currency: "usd", amount: 540, balance_transaction: null })),
      )).outcome,
    ).toBe("dead_letter");
    expect((await h.records.listDeadLetters()).map((d) => d.reason).sort()).toEqual([
      "fx_unverifiable",
      "unknown_mapping",
    ]);
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25 });
  });
});

describe("disputes (PIN-150)", () => {
  async function granted() {
    const h = await harness();
    const intent = await h.createIntent();
    await h.deliver(evt("evt_paid", "checkout.session.completed", session(intent.id)));
    return { h, intent };
  }

  it("a partial dispute freezes ceil makes; funds_reinstated restores them", async () => {
    const { h } = await granted();
    expect(
      (await h.deliver(evt("evt_du", "charge.dispute.created", dispute({ amount: 250 })))).outcome,
    ).toBe("frozen");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, frozen: 13, available: 12 });
    expect(
      (await h.deliver(evt("evt_du_back", "charge.dispute.funds_reinstated", dispute({ amount: 250 })))).outcome,
    ).toBe("restored");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, frozen: 0, available: 25 });
    // A late duplicate freeze for the resolved dispute is a no-op (tombstone).
    expect(
      (await h.deliver(evt("evt_du_late", "charge.dispute.created", dispute({ amount: 250 })))).outcome,
    ).toBe("duplicate_freeze");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ frozen: 0, available: 25 });
  });

  it("closed lost claws back the frozen makes", async () => {
    const { h } = await granted();
    await h.deliver(evt("evt_du", "charge.dispute.created", dispute()));
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ frozen: 25, available: 0 });
    expect(
      (await h.deliver(evt("evt_du_lost", "charge.dispute.closed", dispute({ status: "lost" })))).outcome,
    ).toBe("dispute_final_clawed");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0, frozen: 0, available: 0 });
  });

  it("a won card dispute (created -> funds_withdrawn -> funds_reinstated -> closed won) restores every make (PIN-178)", async () => {
    const { h, intent } = await granted();
    expect(
      (await h.deliver(evt("evt_du", "charge.dispute.created", dispute()))).outcome,
    ).toBe("frozen");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, frozen: 25, available: 0 });
    // Card disputes withdraw about a second later: freeze only, no claw,
    // and no freeze_no_available although nothing is available now.
    expect(
      (await h.deliver(evt("evt_du_wd", "charge.dispute.funds_withdrawn", dispute()))).outcome,
    ).toBe("duplicate_freeze");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, frozen: 25, available: 0 });
    expect(
      (await h.deliver(evt("evt_du_back", "charge.dispute.funds_reinstated", dispute()))).outcome,
    ).toBe("restored");
    expect(
      (await h.deliver(evt("evt_du_won", "charge.dispute.closed", dispute({ status: "won" })))).outcome,
    ).toBe("duplicate_restore");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, frozen: 0, available: 25 });
    expect(await h.records.listDeadLetters()).toEqual([]);
    expect((await h.intents.get(intent.id))?.finalDisputeClawbacks).toBeUndefined();
    expect((await h.ledger.listEntries(SLUG)).filter((e) => e.type === "clawback")).toEqual([]);
  });

  it("closed won alone restores a freeze that funds_withdrawn established (created missed)", async () => {
    const { h } = await granted();
    expect(
      (await h.deliver(evt("evt_du_wd", "charge.dispute.funds_withdrawn", dispute({ amount: 250 })))).outcome,
    ).toBe("frozen");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, frozen: 13, available: 12 });
    expect(
      (await h.deliver(evt("evt_du_late", "charge.dispute.created", dispute({ amount: 250 })))).outcome,
    ).toBe("duplicate_freeze");
    expect(
      (await h.deliver(evt("evt_du_won", "charge.dispute.closed", dispute({ amount: 250, status: "won" })))).outcome,
    ).toBe("restored");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, frozen: 0, available: 25 });
    expect(await h.records.listDeadLetters()).toEqual([]);
  });

  it("created -> funds_withdrawn (twice) -> closed lost claws the floor exactly once and releases the ceil excess (PIN-178)", async () => {
    const { h, intent } = await granted();
    await h.deliver(evt("evt_du", "charge.dispute.created", dispute({ amount: 250 })));
    const withdrawn = evt("evt_du_wd", "charge.dispute.funds_withdrawn", dispute({ amount: 250 }));
    expect((await h.deliver(withdrawn)).outcome).toBe("duplicate_freeze");
    // A Stripe re-delivery of the same event, and a second event id.
    expect(await h.deliver(withdrawn)).toMatchObject({ outcome: "duplicate", duplicate: true });
    expect(
      (await h.deliver(evt("evt_du_wd2", "charge.dispute.funds_withdrawn", dispute({ amount: 250 })))).outcome,
    ).toBe("duplicate_freeze");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, frozen: 13, available: 12 });
    expect(
      (await h.deliver(evt("evt_du_lost", "charge.dispute.closed", dispute({ amount: 250, status: "lost" })))).outcome,
    ).toBe("dispute_final_clawed");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 13, frozen: 0, available: 13 });
    expect(await h.intents.get(intent.id)).toMatchObject({
      finalDisputeClawbacks: { du_test_fake_1: 12 },
    });
    const clawbacks = (await h.ledger.listEntries(SLUG)).filter((e) => e.type === "clawback");
    expect(clawbacks).toHaveLength(1);
    expect(clawbacks[0]).toMatchObject({ amount: 12, disputeId: "du_test_fake_1" });
    expect(await h.records.listDeadLetters()).toEqual([]);
  });

  it("closed lost landing first also releases the ceil excess; a later funds_withdrawn claws nothing more", async () => {
    const { h } = await granted();
    await h.deliver(evt("evt_du", "charge.dispute.created", dispute({ amount: 250 })));
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ frozen: 13, available: 12 });
    expect(
      (await h.deliver(evt("evt_du_lost", "charge.dispute.closed", dispute({ amount: 250, status: "lost" })))).outcome,
    ).toBe("dispute_final_clawed");
    // Floor 12 clawed, the 13th frozen make (ceil excess) is back, not stranded.
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 13, frozen: 0, available: 13 });
    expect(
      (await h.deliver(evt("evt_du_wd", "charge.dispute.funds_withdrawn", dispute({ amount: 250 })))).outcome,
    ).toBe("duplicate_final_clawback");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 13, frozen: 0, available: 13 });
    const clawbacks = (await h.ledger.listEntries(SLUG)).filter((e) => e.type === "clawback");
    expect(clawbacks).toHaveLength(1);
    expect(clawbacks[0]).toMatchObject({ amount: 12, disputeId: "du_test_fake_1" });
  });

  it("concurrent funds_withdrawn and closed lost claw exactly once", async () => {
    const { h } = await granted();
    await h.deliver(evt("evt_du", "charge.dispute.created", dispute({ amount: 250 })));
    const outcomes = await Promise.all([
      h.deliver(evt("evt_du_wd", "charge.dispute.funds_withdrawn", dispute({ amount: 250 }))),
      h.deliver(evt("evt_du_lost", "charge.dispute.closed", dispute({ amount: 250, status: "lost" }))),
    ]);
    expect(outcomes[1].outcome).toBe("dispute_final_clawed");
    expect(["duplicate_freeze", "duplicate_final_clawback"]).toContain(outcomes[0].outcome);
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 13, frozen: 0, available: 13 });
    const clawbacks = (await h.ledger.listEntries(SLUG)).filter((e) => e.type === "clawback");
    expect(clawbacks).toHaveLength(1);
  });

  it("a foreign-currency dispute with no balance transactions freezes via the charge's Stripe exchange rate", async () => {
    const { h } = await granted();
    // 540 presentment cents at the charge's reported rate settles to 250 EUR cents.
    h.client.balanceTransactions["txn_test_fake_charge"] = {
      id: "txn_test_fake_charge",
      amount: 499,
      currency: "eur",
      exchange_rate: 250 / 540,
    };
    expect(
      (await h.deliver(
        evt("evt_du_fx", "charge.dispute.created", dispute({
          currency: "usd",
          amount: 540,
          balance_transactions: [],
        })),
      )).outcome,
    ).toBe("frozen");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, frozen: 13, available: 12 });
    expect(await h.records.listDeadLetters()).toEqual([]);
  });

  it("a reinstate after a final clawback dead-letters for an operator instead of un-clawing", async () => {
    const { h } = await granted();
    await h.deliver(evt("evt_du_lost", "charge.dispute.closed", dispute({ status: "lost" })));
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0 });
    expect(
      (await h.deliver(evt("evt_du_back", "charge.dispute.funds_reinstated", dispute()))).outcome,
    ).toBe("dead_letter");
    expect((await h.records.listDeadLetters()).map((d) => d.reason)).toEqual([
      "reinstated_after_final_clawback",
    ]);
  });

  it("a pre-grant dispute freeze defers and lands capped at the grant", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    await h.intents.recordStripeMapping(
      intent.id,
      { sessionId: SESSION_ID, paymentIntentId: PAYMENT_INTENT_ID, chargeId: CHARGE_ID },
      NOW,
    );
    expect(
      (await h.deliver(evt("evt_du_early", "charge.dispute.created", dispute({ amount: 9_999 })))).outcome,
    ).toBe("frozen");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0, frozen: 0 });
    expect(
      (await h.deliver(evt("evt_paid", "checkout.session.completed", session(intent.id)))).outcome,
    ).toBe("granted");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, frozen: 25, available: 0 });
  });

  it("an early restore tombstones the dispute so a later freeze is a no-op", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    await h.intents.recordStripeMapping(
      intent.id,
      { sessionId: SESSION_ID, paymentIntentId: PAYMENT_INTENT_ID, chargeId: CHARGE_ID },
      NOW,
    );
    expect(
      (await h.deliver(evt("evt_du_restore_first", "charge.dispute.funds_reinstated", dispute()))).outcome,
    ).toBe("restored");
    expect(
      (await h.deliver(evt("evt_paid", "checkout.session.completed", session(intent.id)))).outcome,
    ).toBe("granted");
    expect(
      (await h.deliver(evt("evt_du_late_freeze", "charge.dispute.created", dispute()))).outcome,
    ).toBe("duplicate_freeze");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, frozen: 0, available: 25 });
  });

  it("an unknown dispute charge dead-letters with no freeze", async () => {
    const { h } = await granted();
    expect(
      (await h.deliver(
        evt("evt_du_orphan", "charge.dispute.created", dispute({ charge: "ch_test_unknown", payment_intent: null })),
      )).outcome,
    ).toBe("dead_letter");
    expect((await h.records.listDeadLetters()).map((d) => d.reason)).toEqual(["unknown_mapping"]);
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ frozen: 0, available: 25 });
  });

  it("a dispute delivered before the mapping persisted resolves via the Stripe session lookup (PIN-153)", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    // No recordStripeMapping: fulfilment has not persisted it yet,
    // but the Checkout Session behind the PaymentIntent names the intent.
    h.client.sessionsByPaymentIntent[PAYMENT_INTENT_ID] = session(intent.id);
    expect(
      (await h.deliver(evt("evt_du_fast", "charge.dispute.created", dispute()))).outcome,
    ).toBe("frozen");
    expect(await h.records.listDeadLetters()).toEqual([]);
    const backfilled = await h.intents.get(intent.id);
    expect(backfilled?.stripeChargeId).toBe(CHARGE_ID);
    expect(backfilled?.stripePaymentIntentId).toBe(PAYMENT_INTENT_ID);
    // The late fulfilment then grants into the deferred freeze.
    expect(
      (await h.deliver(evt("evt_paid", "checkout.session.completed", session(intent.id)))).outcome,
    ).toBe("granted");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25, frozen: 25, available: 0 });
  });
});

describe("dead letters are re-runnable (PIN-178)", () => {
  it("a dead-lettered event delivered again runs again; a processed one is still a duplicate", async () => {
    const h = await harness();
    const orphan = evt(
      "evt_orphan",
      "checkout.session.completed",
      session("00000000-0000-4000-8000-000000000000"),
    );
    expect(await h.deliver(orphan)).toEqual({
      eventId: "evt_orphan",
      outcome: "dead_letter",
      duplicate: false,
    });
    expect(await h.records.getProcessed("evt_orphan")).toBeNull();
    // A Dashboard Resend: handled again, not short-circuited.
    expect(await h.deliver(orphan)).toEqual({
      eventId: "evt_orphan",
      outcome: "dead_letter",
      duplicate: false,
    });
    // Same deterministic id: one operator flag, not two.
    expect((await h.records.listDeadLetters()).map((d) => d.reason)).toEqual(["unknown_intent"]);

    const intent = await h.createIntent();
    const paid = evt("evt_paid_ok", "checkout.session.completed", session(intent.id));
    expect((await h.deliver(paid)).outcome).toBe("granted");
    expect(await h.records.getProcessed("evt_paid_ok")).toMatchObject({ outcome: "granted" });
    expect(await h.deliver(paid)).toMatchObject({ outcome: "duplicate", duplicate: true });
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25 });
  });

  it("once the cause is fixed, resending the dead-lettered event applies it exactly once", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    // The refund lands before anything mapped its charge, and
    // Stripe's session lookup has nothing either: unknown_mapping.
    const early = evt("evt_re_early", "refund.created", refund());
    expect((await h.deliver(early)).outcome).toBe("dead_letter");
    expect((await h.records.listDeadLetters()).map((d) => d.reason)).toEqual(["unknown_mapping"]);
    // Fulfilment maps the charge and grants.
    expect(
      (await h.deliver(evt("evt_paid", "checkout.session.completed", session(intent.id)))).outcome,
    ).toBe("granted");
    // The operator resends the refund: it now claws, once.
    expect((await h.deliver(early)).outcome).toBe("refund_clawed");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 0 });
    expect(await h.deliver(early)).toMatchObject({ outcome: "duplicate", duplicate: true });
    const clawbacks = (await h.ledger.listEntries(SLUG)).filter((e) => e.type === "clawback");
    expect(clawbacks).toHaveLength(1);
  });
});

describe("stored purchase terms (PIN-181)", () => {
  const changes: Array<[string, Parameters<typeof resolvePolicy>[0]]> = [
    ["the same pack repriced", { credits: { packs: [{ ...TEST_PACK, eurCents: 999 }] } }],
    ["the pack retired", null],
  ];
  for (const [name, overrides] of changes) {
    it(`an old purchase keeps its own price after a Policy change: ${name}`, async () => {
      const h = await harness();
      const intent = await h.createIntent(); // stored: 25 makes for 499 cents
      h.deps.policy = resolvePolicy(overrides);
      expect(
        (await h.deliver(evt("evt_paid", "checkout.session.completed", session(intent.id)))).outcome,
      ).toBe("granted");
      expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 25 });
      // floor(250 * 25 / 499) = 12 under the stored terms.
      expect(
        (await h.deliver(evt("evt_re", "refund.created", refund({ amount: 250 })))).outcome,
      ).toBe("refund_clawed");
      expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 13 });
      // ceil(100 * 25 / 499) = 6 frozen; the lost close claws floor = 5 and frees 1.
      expect(
        (await h.deliver(evt("evt_du", "charge.dispute.created", dispute({ amount: 100 })))).outcome,
      ).toBe("frozen");
      expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 13, frozen: 6, available: 7 });
      expect(
        (await h.deliver(
          evt("evt_du_lost", "charge.dispute.closed", dispute({ amount: 100, status: "lost" })),
        )).outcome,
      ).toBe("dispute_final_clawed");
      expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 8, frozen: 0, available: 8 });
      expect(await h.records.listDeadLetters()).toEqual([]);
    });
  }

  it("a legacy intent without stored terms falls back to the Policy pack by lookup key", async () => {
    const h = await harness();
    const intent = await h.createIntent();
    // Simulate a record written before PIN-181: no eurCents.
    const legacy = (found: CheckoutIntent | null) => {
      if (found) delete found.eurCents;
      return found;
    };
    const realGet = h.intents.get.bind(h.intents);
    h.intents.get = async (id) => legacy(await realGet(id));
    const realFind = h.intents.findByStripeIds.bind(h.intents);
    h.intents.findByStripeIds = async (lookup) => legacy(await realFind(lookup));

    expect(
      (await h.deliver(evt("evt_paid", "checkout.session.completed", session(intent.id)))).outcome,
    ).toBe("granted");
    expect(
      (await h.deliver(evt("evt_re", "refund.created", refund({ amount: 250 })))).outcome,
    ).toBe("refund_clawed");
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 13 });
    // Once Policy no longer offers that pack, a legacy purchase has no terms: operator flag.
    h.deps.policy = resolvePolicy(null);
    expect(
      (await h.deliver(evt("evt_re2", "refund.created", refund({ id: "re_test_fake_2", amount: 100 }))))
        .outcome,
    ).toBe("dead_letter");
    expect((await h.records.listDeadLetters()).map((d) => d.reason)).toEqual(["pack_mismatch"]);
    expect(await h.ledger.getBalance(SLUG)).toMatchObject({ balance: 13 });
  });
});
