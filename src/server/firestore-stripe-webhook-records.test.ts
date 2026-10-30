import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { FirestoreStripeWebhookRecordStore } from "./firestore-stripe-webhook-records";
import {
  InMemoryStripeWebhookRecordStore,
  deadLetterId,
  type StripeWebhookRecordStore,
} from "./stripe-webhook-records";

/** Fake Firestore, same approach as firestore-credit-ledger-store.test.ts. */
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

class FakeCollection {
  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {}
  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.db, `${this.path}/${id}`);
  }
  async get(): Promise<{ docs: FakeSnapshot[] }> {
    const prefix = `${this.path}/`;
    return {
      docs: [...this.db.store.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .map(([, data]) => new FakeSnapshot(data)),
    };
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
  collection(name: string): FakeCollection {
    return new FakeCollection(this, name);
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

const PROCESSED = {
  eventId: "evt_test_fake_1",
  eventType: "checkout.session.completed",
  outcome: "granted",
  processedAt: 1_000,
};
const DEAD = {
  id: deadLetterId("evt_test_fake_2", "unknown_intent"),
  eventId: "evt_test_fake_2",
  eventType: "checkout.session.completed",
  reason: "unknown_intent",
  operatorFlag: true as const,
  createdAt: 2_000,
};

function describeRecordStore(
  name: string,
  make: () => { store: StripeWebhookRecordStore; reload: () => StripeWebhookRecordStore },
) {
  describe(`StripeWebhookRecordStore (${name})`, () => {
    it("marks an event processed once, and a reloaded store still sees it (replay across restart)", async () => {
      const { store, reload } = make();
      expect(await store.getProcessed(PROCESSED.eventId)).toBeNull();
      expect(await store.markProcessed(PROCESSED)).toBe(true);
      expect(await store.markProcessed({ ...PROCESSED, outcome: "other" })).toBe(false);
      expect(await reload().getProcessed(PROCESSED.eventId)).toEqual(PROCESSED);
    });

    it("dead letters are written once by deterministic id and listed for reconciliation", async () => {
      const { store, reload } = make();
      expect(await store.addDeadLetter(DEAD)).toBe(true);
      expect(await store.addDeadLetter({ ...DEAD, createdAt: 3_000 })).toBe(false);
      expect(await reload().listDeadLetters()).toEqual([DEAD]);
      expect(deadLetterId("evt_x", "amount_mismatch")).toBe("evt_x:amount_mismatch");
    });
  });
}

describeRecordStore("memory", () => {
  const store = new InMemoryStripeWebhookRecordStore();
  return { store, reload: () => store };
});

describeRecordStore("firestore (fake)", () => {
  const fake = new FakeFirestore();
  const make = () => new FirestoreStripeWebhookRecordStore(fake as unknown as Firestore);
  return { store: make(), reload: make };
});
