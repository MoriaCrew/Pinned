import { Timestamp, type Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { describeStarterAllowanceStoreContract } from "../domain/starter-allowance.contract";
import { FirestoreStarterAllowanceStore } from "./firestore-starter-allowance-store";

/**
 * Minimal fake Firestore, same approach as
 * firestore-credit-ledger-store.test.ts: a path-keyed store,
 * buffered transaction writes applied on commit, transactions
 * serialized through a lock (the guarantee real Firestore gives
 * through contention + retry).
 */
type Data = Record<string, unknown>;

class FakeDocRef {
  constructor(
    readonly db: FakeFirestore,
    readonly path: string,
  ) {}
  async get(): Promise<{ data(): Data | undefined }> {
    const value = this.db.store.get(this.path);
    return { data: () => (value ? { ...value } : undefined) };
  }
}

class FakeTransaction {
  constructor(private readonly writes: (() => void)[]) {}
  get(ref: FakeDocRef) {
    return ref.get();
  }
  set(ref: FakeDocRef, data: Data): void {
    this.writes.push(() => ref.db.store.set(ref.path, data));
  }
}

class FakeFirestore {
  readonly store = new Map<string, Data>();
  private lock: Promise<unknown> = Promise.resolve();

  collection(name: string) {
    return { doc: (id: string) => new FakeDocRef(this, `${name}/${id}`) };
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

function makeStore() {
  const fake = new FakeFirestore();
  return { fake, store: new FirestoreStarterAllowanceStore(fake as unknown as Firestore) };
}

describeStarterAllowanceStoreContract("Firestore (fake)", () => makeStore().store);

describe("FirestoreStarterAllowanceStore (PIN-204)", () => {
  it("stores one doc per key with a Timestamp mirror of expireAt for the TTL policy", async () => {
    const { fake, store } = makeStore();
    expect(await store.tryClaim("maker-a", 5_000, { maxBoards: 3, windowMs: 60_000 })).toBe(true);
    const doc = fake.store.get("starterAllowances/maker-a");
    expect(doc).toMatchObject({ key: "maker-a", boards: 1, windowStartedAt: 5_000, expireAt: 65_000 });
    expect(doc?.expireAtTs).toBeInstanceOf(Timestamp);
    expect((doc?.expireAtTs as Timestamp).toMillis()).toBe(65_000);
  });

  it("a refused claim writes nothing", async () => {
    const { fake, store } = makeStore();
    const params = { maxBoards: 1, windowMs: 60_000 };
    await store.tryClaim("maker-a", 5_000, params);
    const before = structuredClone(fake.store.get("starterAllowances/maker-a"));
    expect(await store.tryClaim("maker-a", 6_000, params)).toBe(false);
    expect(fake.store.get("starterAllowances/maker-a")).toMatchObject(before ?? {});
    expect(fake.store.get("starterAllowances/maker-a")?.lastBoardAt).toBe(5_000);
  });
});
