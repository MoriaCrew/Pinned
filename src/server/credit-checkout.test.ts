import { describe, expect, it } from "vitest";
import {
  CreditPriceNotFoundError,
  type CreditCheckout,
  type CreditCheckoutRequest,
} from "../billing/checkout";
import { CONTRACT_SLUG as SLUG, seedBoard } from "../billing/mock-checkout.contract";
import { parseConfig } from "../config";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { InMemoryCreditLedgerStore } from "../domain/credit-ledger";
import type { PlusMode } from "../domain/plus";
import { resolvePolicy, type Policy, type PolicyOverrides } from "../policy/policy";
import { InMemoryCheckoutIntentStore } from "./checkout-intent";
import { createCheckoutIntentStore } from "./checkout-intent-store";
import {
  CreditCheckoutError,
  buyCredits,
  resolveBillingReturn,
  type BuyCreditsDeps,
} from "./credit-checkout";
import { createCreditLedgerStore } from "./credit-ledger-store";
import { FirestoreCheckoutIntentStore } from "./firestore-checkout-intent-store";
import { FirestoreCreditLedgerStore } from "./firestore-credit-ledger-store";

/**
 * Buy service + return resolver (PIN-149) on the in-memory
 * stores with a fake CreditCheckout adapter. No Stripe, no
 * network. The order log is the point of several tests: price
 * resolution first, then intent, then the ledger purchase, and
 * only then the provider session.
 */
const NOW = 1_700_000_000_000;
const PACK = "pinneds_plus_20";

class FakeCreditCheckout implements CreditCheckout {
  readonly resolved: string[] = [];
  readonly requests: CreditCheckoutRequest[] = [];
  resolveError: Error | null = null;
  sessionError: Error | null = null;

  async resolvePriceId(packLookupKey: string): Promise<string> {
    this.resolved.push(packLookupKey);
    this.order.push("resolvePrice");
    if (this.resolveError) throw this.resolveError;
    return "price_fake";
  }

  async createCreditCheckoutSession(request: CreditCheckoutRequest) {
    this.order.push("session");
    this.requests.push(request);
    if (this.sessionError) throw this.sessionError;
    return { url: "https://checkout.example/session", sessionId: "cs_fake" };
  }

  constructor(private readonly order: string[]) {}
}

async function harness(
  options: { mode?: PlusMode; policy?: PolicyOverrides } = {},
) {
  const order: string[] = [];
  const boards = new InMemoryBoardRepository();
  await seedBoard(boards);
  const intents = new InMemoryCheckoutIntentStore();
  const ledger = new InMemoryCreditLedgerStore();
  const realCreate = intents.create.bind(intents);
  intents.create = async (input) => {
    order.push("intent");
    return realCreate(input);
  };
  const realRecord = ledger.recordPurchase.bind(ledger);
  ledger.recordPurchase = async (boardId, input) => {
    order.push("recordPurchase");
    return realRecord(boardId, input);
  };
  const checkout = new FakeCreditCheckout(order);
  const policy: Policy = resolvePolicy(options.policy ?? null);
  const deps: BuyCreditsDeps = {
    boards,
    policy,
    plusMode: options.mode ?? "stripe",
    intents,
    ledger,
    creditCheckout: checkout,
    returnBaseUrl: "https://app.example",
    now: () => NOW,
  };
  return { boards, intents, ledger, checkout, deps, order };
}

describe("buyCredits (PIN-149)", () => {
  it("happy path: intent + purchase recorded before the session, slug never crosses", async () => {
    const { intents, ledger, checkout, deps, order } = await harness();
    const result = await buyCredits(SLUG, { lookupKey: PACK }, deps);
    expect(result).toEqual({ status: "redirect", url: "https://checkout.example/session" });
    expect(order).toEqual(["resolvePrice", "intent", "recordPurchase", "session"]);
    const request = checkout.requests[0];
    expect(request.packLookupKey).toBe(PACK);
    expect(request.credits).toBe(20);
    expect(request.returnBaseUrl).toBe("https://app.example");
    expect(request.intentExpiresAt).toBe(NOW + 1_800_000);
    expect(JSON.stringify(request)).not.toContain(SLUG);

    const intent = await intents.get(request.intentId);
    expect(intent).toMatchObject({
      boardId: SLUG,
      packLookupKey: PACK,
      credits: 20,
      purchaseId: request.intentId,
      status: "pending",
      createdAt: NOW,
      expiresAt: NOW + 1_800_000,
    });
    const account = await ledger.getAccount(SLUG);
    expect(account?.purchases[request.intentId]).toMatchObject({
      credits: 20,
      state: "pending",
      grantedCredits: 0,
    });
    // Buying grants nothing by itself: the webhook grants (PIN-150).
    expect(await ledger.getBalance(SLUG)).toMatchObject({ balance: 0, available: 0 });
    expect(await ledger.listEntries(SLUG)).toEqual([]);
  });

  it("unknown pack is a 400 with nothing written and no provider call", async () => {
    for (const mode of ["stripe", "off"] as const) {
      const { ledger, checkout, deps } = await harness({ mode });
      const error = await buyCredits(SLUG, { lookupKey: "nope" }, deps).catch((e) => e);
      expect(error).toBeInstanceOf(CreditCheckoutError);
      expect(error).toMatchObject({ status: 400, code: "pack_unknown" });
      expect((error as Error).message).not.toContain(SLUG);
      expect(checkout.resolved).toEqual([]);
      expect(await ledger.getAccount(SLUG)).toBeNull();
    }
  });

  it("off and mock answer unavailable: no intent, no purchase, no provider call", async () => {
    for (const mode of ["off", "mock"] as const) {
      const { ledger, checkout, deps } = await harness({ mode });
      expect(await buyCredits(SLUG, { lookupKey: PACK }, deps)).toEqual({
        status: "unavailable",
      });
      expect(checkout.resolved).toEqual([]);
      expect(await ledger.getAccount(SLUG)).toBeNull();
    }
  });

  it("missing Stripe price fails before any intent is created (cap untouched)", async () => {
    const { ledger, checkout, deps } = await harness({
      policy: { credits: { pendingIntentCapPerBoard: 1 } },
    });
    checkout.resolveError = new CreditPriceNotFoundError(PACK);
    const error = await buyCredits(SLUG, { lookupKey: PACK }, deps).catch((e) => e);
    expect(error).toMatchObject({ status: 503, code: "checkout_unavailable" });
    expect(checkout.requests).toEqual([]);
    expect(await ledger.getAccount(SLUG)).toBeNull();
    checkout.resolveError = null;
    expect(await buyCredits(SLUG, { lookupKey: PACK }, deps)).toMatchObject({
      status: "redirect",
    });
  });

  it("the per-board pending cap is a slug-free 429 and creates no session", async () => {
    const { checkout, deps } = await harness({
      policy: { credits: { pendingIntentCapPerBoard: 2 } },
    });
    await buyCredits(SLUG, { lookupKey: PACK }, deps);
    await buyCredits(SLUG, { lookupKey: PACK }, deps);
    const error = await buyCredits(SLUG, { lookupKey: PACK }, deps).catch((e) => e);
    expect(error).toBeInstanceOf(CreditCheckoutError);
    expect(error).toMatchObject({ status: 429, code: "intent_cap_reached" });
    expect((error as Error).message).not.toContain(SLUG);
    expect(checkout.requests).toHaveLength(2);
  });

  it("a failed session closes the intent and its purchase, freeing the cap", async () => {
    const { intents, ledger, checkout, deps } = await harness({
      policy: { credits: { pendingIntentCapPerBoard: 1 } },
    });
    checkout.sessionError = new Error("provider down");
    const error = await buyCredits(SLUG, { lookupKey: PACK }, deps).catch((e) => e);
    expect(error).toMatchObject({ status: 503, code: "checkout_unavailable" });
    expect((error as Error).message).not.toContain("provider down");
    const intentId = checkout.requests[0].intentId;
    expect(await intents.get(intentId)).toMatchObject({ status: "closed" });
    const account = await ledger.getAccount(SLUG);
    expect(account?.purchases[intentId]).toMatchObject({ state: "closed" });
    checkout.sessionError = null;
    expect(await buyCredits(SLUG, { lookupKey: PACK }, deps)).toMatchObject({
      status: "redirect",
    });
  });

  it("an unknown board is the typed 404 the route maps to the uniform body", async () => {
    const { deps } = await harness();
    const error = await buyCredits("A".repeat(22), { lookupKey: PACK }, deps).catch(
      (e) => e,
    );
    expect(error).toMatchObject({ status: 404 });
  });
});

describe("resolveBillingReturn (PIN-149)", () => {
  async function seedIntent(at = NOW, ttlSeconds = 1_800) {
    const intents = new InMemoryCheckoutIntentStore();
    const intent = await intents.create({
      boardId: SLUG,
      packLookupKey: PACK,
      credits: 20,
      at,
      intentTtlSeconds: ttlSeconds,
      pendingIntentCapPerBoard: 3,
    });
    return { intents, intent };
  }

  it("known intents return to the board; success reads processing and grants nothing", async () => {
    const { intents, intent } = await seedIntent();
    const ledger = new InMemoryCreditLedgerStore();
    await ledger.recordPurchase(SLUG, { purchaseId: intent.purchaseId, credits: 20 });
    const deps = { intents, now: () => NOW + 60_000 };
    expect(await resolveBillingReturn(intent.id, "success", deps)).toEqual({
      kind: "board",
      location: `/g/${SLUG}?billing=processing`,
    });
    expect(await resolveBillingReturn(intent.id, "cancel", deps)).toEqual({
      kind: "board",
      location: `/g/${SLUG}?billing=cancelled`,
    });
    // The return path never touches the ledger: still pending, zero balance.
    const account = await ledger.getAccount(SLUG);
    expect(account?.purchases[intent.id]).toMatchObject({ state: "pending" });
    expect(await ledger.getBalance(SLUG)).toMatchObject({ balance: 0 });
  });

  it("a webhook-closed intent still returns to its board", async () => {
    const { intents, intent } = await seedIntent();
    await intents.close(intent.id, NOW + 1_000);
    expect(
      await resolveBillingReturn(intent.id, "success", { intents, now: () => NOW + 2_000 }),
    ).toEqual({ kind: "board", location: `/g/${SLUG}?billing=processing` });
  });

  it("unknown, expired and malformed intents get one identical generic answer", async () => {
    const { intents, intent } = await seedIntent();
    const generic = { kind: "generic", location: "/" };
    expect(await resolveBillingReturn(null, "success", { intents })).toEqual(generic);
    expect(await resolveBillingReturn("", "success", { intents })).toEqual(generic);
    expect(await resolveBillingReturn("x".repeat(201), "success", { intents })).toEqual(
      generic,
    );
    expect(
      await resolveBillingReturn("12345678-1234-4234-8234-1234567890ab", "success", {
        intents,
        now: () => NOW,
      }),
    ).toEqual(generic);
    // Past the TTL: indistinguishable from unknown, and read-only
    // (PIN-178) - the intent stays pending for a late webhook grant.
    expect(
      await resolveBillingReturn(intent.id, "success", {
        intents,
        now: () => NOW + 1_800_000,
      }),
    ).toEqual(generic);
    expect(await intents.get(intent.id)).toEqual(intent);
    // An intent a cap check marked expired answers the same.
    await intents.expire(intent.id, NOW + 1_800_000);
    expect(
      await resolveBillingReturn(intent.id, "success", { intents, now: () => NOW }),
    ).toEqual(generic);
  });

  it("only ever reads the intent store (PIN-178)", async () => {
    const { intents, intent } = await seedIntent();
    const calls: string[] = [];
    const readOnly = {
      get: async (id: string) => {
        calls.push("get");
        return intents.get(id);
      },
    };
    for (const now of [NOW + 60_000, NOW + 1_800_000, NOW + 2 * 86_400_000]) {
      await resolveBillingReturn(intent.id, "success", { intents: readOnly, now: () => now });
    }
    expect(calls).toEqual(["get", "get", "get"]);
    expect(await intents.get(intent.id)).toEqual(intent);
  });
});

describe("credit store selection (PIN-149)", () => {
  it("memory backend picks the in-memory stores, firestore the Firestore ones", () => {
    const memory = parseConfig({});
    expect(createCheckoutIntentStore(memory)).toBeInstanceOf(InMemoryCheckoutIntentStore);
    expect(createCreditLedgerStore(memory)).toBeInstanceOf(InMemoryCreditLedgerStore);
    const hosted = parseConfig({
      DATA_BACKEND: "firestore",
      FIREBASE_PROJECT_ID: "demo-project",
    });
    expect(createCheckoutIntentStore(hosted)).toBeInstanceOf(FirestoreCheckoutIntentStore);
    expect(createCreditLedgerStore(hosted)).toBeInstanceOf(FirestoreCreditLedgerStore);
  });
});
