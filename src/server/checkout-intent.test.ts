import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../policy/policy";
import {
  InMemoryCheckoutIntentStore,
  toPublicCheckoutIntent,
  type CheckoutIntentStore,
  type CreateCheckoutIntentInput,
} from "./checkout-intent";
import { FirestoreCheckoutIntentStore } from "./firestore-checkout-intent-store";

/**
 * Fake Firestore for checkout intents, same approach as
 * firestore-budget-store.test.ts: buffered transaction writes,
 * transactions serialized through a lock (the observable
 * contention + retry guarantee). Only doc get/set inside
 * transactions is exercised — the store uses no queries.
 */
type Data = Record<string, unknown>;

class FakeSnapshot {
  constructor(private readonly value?: Data) {}
  get exists(): boolean {
    return this.value !== undefined;
  }
  data(): Data | undefined {
    return this.value ? structuredClone(this.value) : undefined;
  }
}

class FakeDocRef {
  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {}
  async get(): Promise<FakeSnapshot> {
    return new FakeSnapshot(this.db.store.get(this.path));
  }
  applySet(data: Data): void {
    this.db.store.set(this.path, structuredClone(data));
  }
}

class FakeTransaction {
  constructor(private readonly writes: (() => void)[]) {}
  async get(ref: FakeDocRef): Promise<FakeSnapshot> {
    return ref.get();
  }
  set(ref: FakeDocRef, data: Data): void {
    this.writes.push(() => ref.applySet(data));
  }
}

class FakeFirestore {
  readonly store = new Map<string, Data>();
  private lock: Promise<unknown> = Promise.resolve();

  collection(name: string) {
    const db = this;
    return {
      doc: (id: string) => new FakeDocRef(db, `${name}/${id}`),
      where: (field: string, _op: string, value: unknown) => ({
        limit: (n: number) => ({
          get: async () => ({
            docs: [...db.store.entries()]
              .filter(([path, data]) => path.startsWith(`${name}/`) && data[field] === value)
              .slice(0, n)
              .map(([, data]) => new FakeSnapshot(data)),
          }),
        }),
      }),
    };
  }
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const run = async () => {
      const writes: (() => void)[] = [];
      const result = await fn(new FakeTransaction(writes));
      for (const write of writes) write();
      return result;
    };
    const chained = this.lock.then(run, run);
    this.lock = chained.catch(() => undefined);
    return chained;
  }
}

function sequentialIds() {
  let n = 0;
  return () => `intent-${++n}`;
}

const BOARD = "board-slug-secret-1";
const AT = 1_700_000_000_000;
const TTL_SECONDS = DEFAULT_POLICY.credits.intentTtlSeconds;
const CAP = DEFAULT_POLICY.credits.pendingIntentCapPerBoard;

function createInput(over: Partial<CreateCheckoutIntentInput> = {}): CreateCheckoutIntentInput {
  return {
    boardId: BOARD,
    packLookupKey: "pinneds_credits_25",
    credits: 25,
    at: AT,
    intentTtlSeconds: TTL_SECONDS,
    pendingIntentCapPerBoard: CAP,
    ...over,
  };
}

function describeCheckoutIntentStore(
  name: string,
  make: () => { store: CheckoutIntentStore; fake?: FakeFirestore },
) {
  describe(`CheckoutIntentStore (${name})`, () => {
    it("mints a pending intent: opaque id, internal board mapping, pack + purchase id, TTL expiry", async () => {
      const { store } = make();
      const intent = await store.create(createInput());
      expect(intent.id).toBe("intent-1");
      expect(intent.boardId).toBe(BOARD);
      expect(intent.packLookupKey).toBe("pinneds_credits_25");
      expect(intent.credits).toBe(25);
      expect(intent.purchaseId).toBe(intent.id);
      expect(intent.status).toBe("pending");
      expect(intent.createdAt).toBe(AT);
      expect(intent.expiresAt).toBe(AT + TTL_SECONDS * 1000);
      expect(await store.get(intent.id)).toEqual(intent);
      expect(await store.get("nope")).toBeNull();
    });

    it("enforces the per-board pending cap; closing one frees a slot; other boards are unaffected", async () => {
      const { store } = make();
      const created = [];
      for (let i = 0; i < CAP; i++) created.push(await store.create(createInput()));
      await expect(store.create(createInput())).rejects.toThrow(RangeError);
      await store.close(created[0].id, AT + 1);
      expect((await store.create(createInput({ at: AT + 2 }))).status).toBe("pending");
      await expect(store.create(createInput({ at: AT + 3 }))).rejects.toThrow(RangeError);
      expect(
        (await store.create(createInput({ boardId: "other-board", at: AT + 3 }))).status,
      ).toBe("pending");
    });

    it("concurrent creates at cap 1: exactly one proceeds", async () => {
      const { store } = make();
      const results = await Promise.allSettled([
        store.create(createInput({ pendingIntentCapPerBoard: 1 })),
        store.create(createInput({ pendingIntentCapPerBoard: 1 })),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RangeError);
    });

    it("an intent past its TTL stays pending until a cap check or expire moves it (PIN-178)", async () => {
      const { store } = make();
      const intent = await store.create(createInput());
      // No read path expires it (the webhook and the return
      // redirect only `get`), however late the read.
      expect(await store.get(intent.id)).toEqual(intent);
      expect((await store.expire(intent.id, intent.expiresAt + 86_400_000))?.status).toBe("expired");
    });

    it("stale pending intents stop counting against the cap and are expired by the next create", async () => {
      const { store } = make();
      const stale = await store.create(
        createInput({ pendingIntentCapPerBoard: 1 }),
      );
      const fresh = await store.create(
        createInput({ pendingIntentCapPerBoard: 1, at: stale.expiresAt }),
      );
      expect(fresh.status).toBe("pending");
      expect((await store.get(stale.id))?.status).toBe("expired");
      // A late grant can still finalize the lazily expired intent,
      // and doing so does not take the freed slot back (PIN-178).
      expect((await store.close(stale.id, stale.expiresAt + 30_000))?.status).toBe("closed");
      await expect(
        store.create(createInput({ pendingIntentCapPerBoard: 1, at: stale.expiresAt + 1 })),
      ).rejects.toThrow(RangeError);
      expect((await store.close(fresh.id, stale.expiresAt + 2))?.status).toBe("closed");
      expect(
        (await store.create(createInput({ pendingIntentCapPerBoard: 1, at: stale.expiresAt + 3 })))
          .status,
      ).toBe("pending");
    });

    it("expire only fires on a pending intent at/after expiry and is idempotent; close is final", async () => {
      const { store } = make();
      const a = await store.create(createInput());
      expect((await store.expire(a.id, a.expiresAt - 1))?.status).toBe("pending");
      expect((await store.expire(a.id, a.expiresAt))?.status).toBe("expired");
      expect((await store.expire(a.id, a.expiresAt + 5))).toMatchObject({
        status: "expired",
        closedAt: a.expiresAt,
      });
      expect(await store.expire("nope", AT)).toBeNull();
      // An expired intent closes (late grant or terminal event).
      expect(await store.close(a.id, a.expiresAt + 10)).toMatchObject({
        status: "closed",
        closedAt: a.expiresAt + 10,
      });
      expect((await store.expire(a.id, a.expiresAt + 20))?.status).toBe("closed");

      const b = await store.create(createInput());
      expect((await store.close(b.id, AT + 10))?.status).toBe("closed");
      expect(await store.close(b.id, AT + 11)).toMatchObject({ status: "closed", closedAt: AT + 10 });
      expect((await store.expire(b.id, b.expiresAt))?.status).toBe("closed");
      expect(await store.close("nope", AT)).toBeNull();
    });

    it("records the Stripe mapping idempotently, refuses a conflicting remap, and resolves by Stripe ids (PIN-150)", async () => {
      const { store } = make();
      const intent = await store.create(createInput());
      const mapped = await store.recordStripeMapping(
        intent.id,
        { sessionId: "cs_test_fake_1", paymentIntentId: "pi_test_fake_1" },
        AT + 1,
      );
      expect(mapped).toMatchObject({
        stripeSessionId: "cs_test_fake_1",
        stripePaymentIntentId: "pi_test_fake_1",
      });
      const granted = await store.recordStripeMapping(
        intent.id,
        { sessionId: "cs_test_fake_1", chargeId: "ch_test_fake_1" },
        AT + 2,
        AT + 2,
      );
      expect(granted).toMatchObject({ stripeChargeId: "ch_test_fake_1", grantedAt: AT + 2 });
      await expect(
        store.recordStripeMapping(intent.id, { chargeId: "ch_test_other" }, AT + 3),
      ).rejects.toThrow(RangeError);
      expect((await store.get(intent.id))?.stripeChargeId).toBe("ch_test_fake_1");
      expect((await store.findByStripeIds({ chargeId: "ch_test_fake_1" }))?.id).toBe(intent.id);
      expect((await store.findByStripeIds({ paymentIntentId: "pi_test_fake_1" }))?.id).toBe(intent.id);
      expect((await store.findByStripeIds({ sessionId: "cs_test_fake_1" }))?.id).toBe(intent.id);
      expect(await store.findByStripeIds({ chargeId: "ch_test_unknown" })).toBeNull();
      expect(await store.recordStripeMapping("nope", { chargeId: "ch_x" }, AT)).toBeNull();
      // Closed intents still resolve: refunds land long after the grant closed it.
      await store.close(intent.id, AT + 4);
      expect((await store.findByStripeIds({ chargeId: "ch_test_fake_1" }))?.status).toBe("closed");
    });

    it("counts refund accounting and final dispute clawbacks exactly once per id (PIN-150)", async () => {
      const { store } = make();
      const intent = await store.create(createInput());
      expect(await store.applyRefundAccounting(intent.id, "re_test_fake_1", 250, 12)).toMatchObject({
        applied: true,
        intent: { refundedEurCents: 250, refundClawedMakes: 12 },
      });
      expect(await store.applyRefundAccounting(intent.id, "re_test_fake_1", 250, 12)).toMatchObject({
        applied: false,
        intent: { refundedEurCents: 250, refundClawedMakes: 12 },
      });
      expect(await store.applyRefundAccounting(intent.id, "re_test_fake_2", 249, 13)).toMatchObject({
        applied: true,
        intent: {
          refundedEurCents: 499,
          refundClawedMakes: 25,
          countedRefundIds: ["re_test_fake_1", "re_test_fake_2"],
        },
      });
      expect(await store.applyRefundAccounting("nope", "re_x", 1, 0)).toEqual({
        intent: null,
        applied: false,
      });
      expect(await store.recordFinalDisputeClawback(intent.id, "du_test_fake_1", 12)).toMatchObject({
        applied: true,
        intent: { finalDisputeClawbacks: { du_test_fake_1: 12 } },
      });
      expect(await store.recordFinalDisputeClawback(intent.id, "du_test_fake_1", 12)).toMatchObject({
        applied: false,
      });
      await expect(store.applyRefundAccounting(intent.id, "re_bad", -1, 0)).rejects.toThrow(
        RangeError,
      );
      // countRefund prices from the stored cumulative atomically:
      // independent of the accounting above (fresh intent), two
      // partials reach the whole pack and a repeat replays its delta.
      const countedIntent = await store.create(createInput());
      expect(await store.countRefund(countedIntent.id, "re_test_fake_a", 250, 499, 25)).toMatchObject({
        applied: true,
        deltaMakes: 12,
      });
      expect(await store.countRefund(countedIntent.id, "re_test_fake_b", 249, 499, 25)).toMatchObject({
        applied: true,
        deltaMakes: 13,
        intent: {
          refundedEurCents: 499,
          refundClawedMakes: 25,
          refundMakesById: { re_test_fake_a: 12, re_test_fake_b: 13 },
        },
      });
      expect(await store.countRefund(countedIntent.id, "re_test_fake_a", 250, 499, 25)).toMatchObject({
        applied: false,
        deltaMakes: 12,
        intent: { refundedEurCents: 499, refundClawedMakes: 25 },
      });
      expect(await store.countRefund("nope", "re_x", 1, 499, 25)).toEqual({
        intent: null,
        applied: false,
        deltaMakes: 0,
      });
    });

    it("rejects invalid create inputs with RangeError and stores nothing resolvable", async () => {
      const { store } = make();
      await expect(store.create(createInput({ boardId: " " }))).rejects.toThrow(RangeError);
      await expect(store.create(createInput({ credits: 0 }))).rejects.toThrow(RangeError);
      await expect(store.create(createInput({ intentTtlSeconds: 0 }))).rejects.toThrow(RangeError);
      await expect(
        store.create(createInput({ pendingIntentCapPerBoard: 0 })),
      ).rejects.toThrow(RangeError);
    });
  });
}

describeCheckoutIntentStore("memory", () => ({
  store: new InMemoryCheckoutIntentStore({ newId: sequentialIds() }),
}));

describeCheckoutIntentStore("firestore (fake)", () => {
  const fake = new FakeFirestore();
  return {
    fake,
    store: new FirestoreCheckoutIntentStore(fake as unknown as Firestore, {
      newId: sequentialIds(),
    }),
  };
});

describe("CheckoutIntent opacity (PIN-148)", () => {
  it("the public shape carries no board identifier beyond the opaque intent id", async () => {
    const store = new InMemoryCheckoutIntentStore({ newId: sequentialIds() });
    const intent = await store.create(createInput());
    const pub = toPublicCheckoutIntent(intent);
    expect(Object.keys(pub).sort()).toEqual([
      "createdAt",
      "credits",
      "expiresAt",
      "id",
      "packLookupKey",
      "status",
    ]);
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain(BOARD);
    expect(serialized.toLowerCase()).not.toContain("board");
    expect(serialized.toLowerCase()).not.toContain("slug");
    expect(pub).not.toHaveProperty("purchaseId");
  });

  it("the default mint is a random UUID unrelated to the board", async () => {
    const store = new InMemoryCheckoutIntentStore();
    const a = await store.create(createInput());
    const b = await store.create(createInput());
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(a.id).toMatch(uuid);
    expect(b.id).toMatch(uuid);
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toContain(BOARD);
  });

  it("the Firestore layout resolves by intent id alone, with the board mapping only inside the doc", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreCheckoutIntentStore(fake as unknown as Firestore, {
      newId: sequentialIds(),
    });
    const intent = await store.create(createInput());
    expect(fake.store.get(`checkoutIntents/${intent.id}`)).toMatchObject({
      id: intent.id,
      boardId: BOARD,
      purchaseId: intent.id,
      status: "pending",
    });
    expect(fake.store.get(`checkoutIntentBoards/${BOARD}`)).toMatchObject({
      pendingIntentIds: [intent.id],
    });
    await store.close(intent.id, AT + 1);
    expect(fake.store.get(`checkoutIntentBoards/${BOARD}`)).toMatchObject({
      pendingIntentIds: [],
    });
  });
});
