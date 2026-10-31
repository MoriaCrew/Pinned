import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { InMemoryCreditLedgerStore } from "../domain/credit-ledger";
import { resolvePolicy } from "../policy/policy";
import {
  ensureStarterMakes,
  photoDebitEventId,
  readAvailableMakes,
  starterEventId,
  tryDebitMake,
  type CreditPoolDeps,
} from "./credit-pool";
import { FirestoreCreditLedgerStore } from "./firestore-credit-ledger-store";

/**
 * Fake Firestore for the credit ledger, same approach as
 * firestore-board-repository.test.ts: a path-keyed store,
 * buffered transaction writes applied on commit, transactions
 * serialized through a lock (the observable guarantee real
 * Firestore gives via contention + retry — the loser's callback
 * re-reads committed state). Subcollections are plain path
 * prefixes; only whole-collection gets are exercised. Every get
 * is logged (`reads`: a doc path, or `<collection>/*` for a
 * whole-collection get) and transactions are counted, so the
 * PIN-179 cost contract is observable.
 */
type Data = Record<string, unknown>;

class FakeSnapshot {
  constructor(
    readonly ref: FakeDocRef,
    private readonly value?: Data,
  ) {}
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
    this.db.reads.push(this.path);
    return new FakeSnapshot(this, this.db.store.get(this.path));
  }
  applySet(data: Data): void {
    this.db.store.set(this.path, structuredClone(data));
  }
  applyDelete(): void {
    this.db.store.delete(this.path);
  }
  collection(name: string): FakeCollection {
    return new FakeCollection(this.db, `${this.path}/${name}`);
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
    this.db.reads.push(`${this.path}/*`);
    const prefix = `${this.path}/`;
    const docs = [...this.db.store.entries()]
      .filter(
        ([path]) =>
          path.startsWith(prefix) && !path.slice(prefix.length).includes("/"),
      )
      .map(([path, data]) => new FakeSnapshot(new FakeDocRef(this.db, path), data));
    return { docs };
  }
}

class FakeTransaction {
  constructor(private readonly writes: (() => void)[]) {}
  async get(
    target: FakeDocRef | FakeCollection,
  ): Promise<FakeSnapshot | { docs: FakeSnapshot[] }> {
    return target.get();
  }
  set(ref: FakeDocRef, data: Data): void {
    this.writes.push(() => ref.applySet(data));
  }
  delete(ref: FakeDocRef): void {
    this.writes.push(() => ref.applyDelete());
  }
}

class FakeFirestore {
  readonly store = new Map<string, Data>();
  reads: string[] = [];
  transactions = 0;
  private lock: Promise<unknown> = Promise.resolve();

  resetCounts(): void {
    this.reads = [];
    this.transactions = 0;
  }
  collection(name: string): FakeCollection {
    return new FakeCollection(this, name);
  }
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    this.transactions += 1;
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
  return {
    fake,
    store: new FirestoreCreditLedgerStore(fake as unknown as Firestore),
  };
}

const BOARD = "board-1";

async function grantedBoard(
  store: FirestoreCreditLedgerStore,
  packCredits = 25,
) {
  await store.recordPurchase(BOARD, { purchaseId: "p1", credits: packCredits });
  await store.grantPurchase(BOARD, { eventId: "evt-grant", purchaseId: "p1", at: 1_000 });
  return store;
}

describe("FirestoreCreditLedgerStore (PIN-148, fake Firestore)", () => {
  it("unknown board reads zero: null account, zero balance, no entries", async () => {
    const { store } = makeStore();
    expect(await store.getAccount("ghost")).toBeNull();
    expect(await store.getBalance("ghost")).toEqual({
      boardId: "ghost",
      balance: 0,
      frozen: 0,
      pendingClawback: 0,
      starterGranted: false,
      available: 0,
    });
    expect(await store.listEntries("ghost")).toEqual([]);
  });

  it("persists multi-doc: head carries no entries/purchases; entry and purchase docs are keyed by id", async () => {
    const { fake, store } = makeStore();
    await grantedBoard(store);
    await store.debit(BOARD, { eventId: "evt-debit", amount: 5, at: 2_000 });

    const head = fake.store.get(`creditAccounts/${BOARD}`);
    expect(head).toMatchObject({ boardId: BOARD, balance: 20, frozen: 0 });
    expect(head).not.toHaveProperty("entries");
    expect(head).not.toHaveProperty("appliedEventIds");
    expect(head).not.toHaveProperty("purchases");
    expect(fake.store.get(`creditAccounts/${BOARD}/purchases/p1`)).toMatchObject({
      purchaseId: "p1",
      credits: 25,
      state: "granted",
    });
    const entryPaths = [...fake.store.keys()]
      .filter((p) => p.startsWith(`creditAccounts/${BOARD}/entries/`))
      .sort();
    expect(entryPaths).toEqual([
      `creditAccounts/${BOARD}/entries/evt-debit`,
      `creditAccounts/${BOARD}/entries/evt-grant`,
    ]);
  });

  it("entries are append-only: later writes never change an earlier entry doc, and listEntries keeps append order", async () => {
    const { fake, store } = makeStore();
    await grantedBoard(store);
    const grantDoc = structuredClone(
      fake.store.get(`creditAccounts/${BOARD}/entries/evt-grant`),
    );
    // Same createdAt on purpose: order must come from append order.
    await store.debit(BOARD, { eventId: "evt-debit-z", amount: 5, at: 1_000 });
    await store.debit(BOARD, { eventId: "evt-debit-a", amount: 5, at: 1_000 });
    expect(fake.store.get(`creditAccounts/${BOARD}/entries/evt-grant`)).toEqual(grantDoc);
    expect((await store.listEntries(BOARD)).map((e) => e.id)).toEqual([
      "evt-grant",
      "evt-debit-z",
      "evt-debit-a",
    ]);
    const account = await store.getAccount(BOARD);
    expect(account?.appliedEventIds).toEqual(["evt-grant", "evt-debit-z", "evt-debit-a"]);
    expect(account?.entries).toEqual(await store.listEntries(BOARD));
    expect(account?.entries[0]).not.toHaveProperty("_seq");
  });

  it("reconstructs exactly the account the in-memory store builds from the same ops", async () => {
    const { store } = makeStore();
    const memory = new InMemoryCreditLedgerStore();
    const ops: ((s: FirestoreCreditLedgerStore | InMemoryCreditLedgerStore) => Promise<unknown>)[] = [
      (s) => s.grantStarter(BOARD, { eventId: "e-starter", amount: 25, at: 1 }),
      (s) => s.recordPurchase(BOARD, { purchaseId: "p1", credits: 60 }),
      (s) => s.grantPurchase(BOARD, { eventId: "e-grant", purchaseId: "p1", at: 2 }),
      (s) => s.freeze(BOARD, { eventId: "e-freeze", purchaseId: "p1", disputeId: "dp-1", amount: 10, at: 3 }),
      (s) => s.debit(BOARD, { eventId: "e-debit", amount: 5, at: 4 }),
      (s) => s.restore(BOARD, { eventId: "e-restore", purchaseId: "p1", disputeId: "dp-1", at: 5 }),
      (s) => s.clawback(BOARD, { eventId: "e-claw", purchaseId: "p1", amount: 15, refundId: "re-1", at: 6 }),
    ];
    // Compare through JSON: Firestore numbers round-trip -0 deltas
    // (a grant with no debt to pay down) to 0, which is the same
    // value at the persistence boundary.
    const viaJson = (value: unknown) => JSON.parse(JSON.stringify(value));
    for (const op of ops) {
      expect(viaJson(await op(store))).toEqual(viaJson(await op(memory)));
    }
    expect(viaJson(await store.getAccount(BOARD))).toEqual(
      viaJson(await memory.getAccount(BOARD)),
    );
    expect(await store.getBalance(BOARD)).toEqual(await memory.getBalance(BOARD));
    expect(viaJson(await store.listEntries(BOARD))).toEqual(
      viaJson(await memory.listEntries(BOARD)),
    );
  });

  it("duplicate event replay after reload (fresh store over the same data) is a no-op", async () => {
    const { fake, store } = makeStore();
    await grantedBoard(store);
    await store.debit(BOARD, { eventId: "evt-debit", amount: 5, at: 2_000 });

    const reloaded = new FirestoreCreditLedgerStore(fake as unknown as Firestore);
    expect(
      (await reloaded.grantPurchase(BOARD, { eventId: "evt-grant", purchaseId: "p1", at: 3_000 })).applied,
    ).toBe(false);
    expect(
      (await reloaded.debit(BOARD, { eventId: "evt-debit", amount: 5, at: 3_000 })).applied,
    ).toBe(false);
    expect((await reloaded.getBalance(BOARD)).balance).toBe(20);
    expect(await reloaded.listEntries(BOARD)).toHaveLength(2);
  });

  it("concurrent debits cannot overspend: exactly one of two 20-of-25 debits lands", async () => {
    const { store } = makeStore();
    await grantedBoard(store, 25);
    const results = await Promise.allSettled([
      store.debit(BOARD, { eventId: "evt-debit-1", amount: 20, at: 2_000 }),
      store.debit(BOARD, { eventId: "evt-debit-2", amount: 20, at: 2_000 }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RangeError);
    expect((await store.getBalance(BOARD)).balance).toBe(5);
    expect((await store.listEntries(BOARD)).filter((e) => e.type === "debit")).toHaveLength(1);
  });

  it("concurrent grants of one purchase cannot double-grant", async () => {
    const { store } = makeStore();
    await store.recordPurchase(BOARD, { purchaseId: "p1", credits: 60 });
    const results = await Promise.all([
      store.grantPurchase(BOARD, { eventId: "evt-grant-1", purchaseId: "p1", at: 1_000 }),
      store.grantPurchase(BOARD, { eventId: "evt-grant-2", purchaseId: "p1", at: 1_000 }),
    ]);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(results.filter((r) => !r.applied)).toHaveLength(1);
    expect((await store.getBalance(BOARD)).balance).toBe(60);
    expect((await store.listEntries(BOARD)).filter((e) => e.type === "purchase_grant")).toHaveLength(1);
  });

  it("a thrown operation writes nothing at all", async () => {
    const { fake, store } = makeStore();
    await grantedBoard(store, 25);
    const before = structuredClone([...fake.store.entries()]);
    await expect(
      store.debit(BOARD, { eventId: "evt-too-big", amount: 26, at: 2_000 }),
    ).rejects.toThrow(RangeError);
    expect([...fake.store.entries()]).toEqual(before);
  });

  it("boards are isolated: one board's writes never touch another's docs", async () => {
    const { fake, store } = makeStore();
    await grantedBoard(store, 25);
    await store.grantStarter("board-2", { eventId: "evt-starter-2", amount: 25, at: 1 });
    await store.debit(BOARD, { eventId: "evt-debit", amount: 25, at: 2 });
    expect((await store.getBalance(BOARD)).available).toBe(0);
    expect((await store.getBalance("board-2")).available).toBe(25);
    expect(
      [...fake.store.keys()].filter((p) => p.startsWith("creditAccounts/board-2/entries/")),
    ).toEqual(["creditAccounts/board-2/entries/evt-starter-2"]);
    expect(await store.getAccount("never-touched")).toBeNull();
    expect(fake.store.has("creditAccounts/never-touched")).toBe(false);
  });
});

const HEAD = `creditAccounts/${BOARD}`;

function poolDeps(
  store: FirestoreCreditLedgerStore,
  enabled = true,
): CreditPoolDeps {
  return {
    credits: store,
    policy: resolvePolicy({ credits: { enabled, starterMakes: 25 } }),
    now: () => 1_000,
  };
}

async function starterEntries(store: FirestoreCreditLedgerStore) {
  return (await store.listEntries(BOARD)).filter((e) => e.type === "starter_grant");
}

describe("cheap balance read (PIN-179, fake Firestore)", () => {
  it("getBalance on a granted board is one head-doc get: no transaction, no subcollection read", async () => {
    const { fake, store } = makeStore();
    await store.grantStarter(BOARD, { eventId: "e-starter", amount: 25, at: 1 });
    await store.recordPurchase(BOARD, { purchaseId: "p1", credits: 60 });
    await store.grantPurchase(BOARD, { eventId: "e-grant", purchaseId: "p1", at: 2 });
    await store.freeze(BOARD, { eventId: "e-freeze", purchaseId: "p1", disputeId: "dp-1", amount: 10, at: 3 });
    await store.debit(BOARD, { eventId: "e-debit", amount: 5, at: 4 });
    fake.resetCounts();

    expect(await store.getBalance(BOARD)).toEqual({
      boardId: BOARD,
      balance: 80,
      frozen: 10,
      pendingClawback: 0,
      starterGranted: true,
      available: 70,
    });
    expect(fake.transactions).toBe(0);
    expect(fake.reads).toEqual([HEAD]);
  });

  it("board polls on a granted board cost one head read each and no ledger transaction", async () => {
    const { fake, store } = makeStore();
    const deps = poolDeps(store);
    await ensureStarterMakes(BOARD, deps); // the create-board path
    fake.resetCounts();

    for (let i = 0; i < 3; i += 1) {
      expect(await readAvailableMakes(BOARD, deps)).toBe(25);
    }
    expect(fake.transactions).toBe(0);
    expect(fake.reads).toEqual([HEAD, HEAD, HEAD]);
  });

  it("a never-touched board gets the starter exactly once under concurrent first touches", async () => {
    const { fake, store } = makeStore();
    const deps = poolDeps(store);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => readAvailableMakes(BOARD, deps)),
    );
    expect(results).toEqual([25, 25, 25, 25]);
    // All four saw no head and raced into the grant; it still landed once.
    expect(fake.transactions).toBe(4);
    expect((await starterEntries(store)).map((e) => e.id)).toEqual([starterEventId(BOARD)]);

    fake.resetCounts();
    expect(await readAvailableMakes(BOARD, deps)).toBe(25);
    expect(fake.transactions).toBe(0);
    expect(fake.reads).toEqual([HEAD]);
  });

  it("mixed concurrent first touches (polls and a make) grant once and debit once", async () => {
    const { store } = makeStore();
    const deps = poolDeps(store);
    const [, debit] = await Promise.all([
      readAvailableMakes(BOARD, deps),
      tryDebitMake(BOARD, photoDebitEventId("job-1"), deps),
      readAvailableMakes(BOARD, deps),
    ]);
    expect(debit).toBe("debited");
    expect((await store.listEntries(BOARD)).map((e) => e.type).sort()).toEqual([
      "debit",
      "starter_grant",
    ]);
    expect((await store.getBalance(BOARD)).available).toBe(24);
  });

  it("a head without the starter (a purchase landed first) grants it once, then reads cheap", async () => {
    const { fake, store } = makeStore();
    const deps = poolDeps(store);
    await store.recordPurchase(BOARD, { purchaseId: "p1", credits: 60 });
    await store.grantPurchase(BOARD, { eventId: "e-grant", purchaseId: "p1", at: 2 });
    fake.resetCounts();

    expect(await readAvailableMakes(BOARD, deps)).toBe(85);
    expect(fake.transactions).toBe(1);
    fake.resetCounts();
    expect(await readAvailableMakes(BOARD, deps)).toBe(85);
    expect(fake.transactions).toBe(0);
    expect(fake.reads).toEqual([HEAD]);
    expect(await starterEntries(store)).toHaveLength(1);
  });

  it("a make on a granted board runs only the debit transaction", async () => {
    const { fake, store } = makeStore();
    const deps = poolDeps(store);
    await ensureStarterMakes(BOARD, deps);
    fake.resetCounts();

    expect(await tryDebitMake(BOARD, photoDebitEventId("job-1"), deps)).toBe("debited");
    expect(fake.transactions).toBe(1);
    expect((await store.getBalance(BOARD)).available).toBe(24);
  });

  it("replays stay once-only: create-path ensure, a duplicate starter event, a reloaded store", async () => {
    const { fake, store } = makeStore();
    const deps = poolDeps(store);
    expect(await readAvailableMakes(BOARD, deps)).toBe(25); // lazy grant
    await ensureStarterMakes(BOARD, deps); // create-path replay
    expect(
      (await store.grantStarter(BOARD, { eventId: starterEventId(BOARD), amount: 25, at: 2 })).applied,
    ).toBe(false);

    const reloaded = new FirestoreCreditLedgerStore(fake as unknown as Firestore);
    fake.resetCounts();
    expect(await readAvailableMakes(BOARD, poolDeps(reloaded))).toBe(25);
    expect(fake.transactions).toBe(0);
    expect(await starterEntries(store)).toHaveLength(1);
  });

  it("credits disabled: no ledger read or transaction at all", async () => {
    const { fake, store } = makeStore();
    const deps = poolDeps(store, false);
    expect(await readAvailableMakes(BOARD, deps)).toBeNull();
    expect(await tryDebitMake(BOARD, photoDebitEventId("job-1"), deps)).toBe("disabled");
    expect(fake.reads).toEqual([]);
    expect(fake.transactions).toBe(0);
  });
});
