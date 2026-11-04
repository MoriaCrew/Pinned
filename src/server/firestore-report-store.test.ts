import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { describeReportStoreContract } from "../domain/report-store.contract";
import { FirestoreReportStore } from "./firestore-report-store";

/**
 * Minimal fake Firestore for one flat collection, same approach as
 * firestore-starter-allowance-store.test.ts: a path-keyed store,
 * buffered transaction writes applied on commit, transactions
 * serialized through a lock, plus the one-where query with orderBy and
 * limit that `listOpenDue` needs (`==` and `<` only).
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
    readonly db: FakeFirestore,
    readonly path: string,
  ) {}
  async get(): Promise<FakeSnapshot> {
    return new FakeSnapshot(this.db.store.get(this.path));
  }
  async create(data: Data): Promise<void> {
    if (this.db.store.has(this.path)) throw Object.assign(new Error("already exists"), { code: 6 });
    this.db.store.set(this.path, structuredClone(data));
  }
  async set(data: Data): Promise<void> {
    this.db.store.set(this.path, structuredClone(data));
  }
}

interface Filter {
  field: string;
  op: string;
  value: unknown;
}

class FakeQuery {
  constructor(
    private readonly db: FakeFirestore,
    private readonly prefix: string,
    private readonly filter: Filter | null = null,
    private readonly order: string | null = null,
    private readonly max: number | null = null,
  ) {}
  where(field: string, op: string, value: unknown): FakeQuery {
    if (this.filter) throw new Error("fake supports one where clause");
    return new FakeQuery(this.db, this.prefix, { field, op, value }, this.order, this.max);
  }
  orderBy(field: string): FakeQuery {
    return new FakeQuery(this.db, this.prefix, this.filter, field, this.max);
  }
  limit(n: number): FakeQuery {
    return new FakeQuery(this.db, this.prefix, this.filter, this.order, n);
  }
  async get(): Promise<{ docs: FakeSnapshot[] }> {
    let rows = [...this.db.store.entries()]
      .filter(([path]) => path.startsWith(`${this.prefix}/`))
      .map(([, data]) => data);
    const filter = this.filter;
    if (filter) {
      rows = rows.filter((data) => {
        const actual = data[filter.field];
        if (filter.op === "==") return actual === filter.value;
        if (filter.op === "<") return typeof actual === "number" && actual < (filter.value as number);
        throw new Error(`fake only supports == and <, got ${filter.op}`);
      });
    }
    if (this.order) {
      const key = this.order;
      rows = rows
        .filter((data) => data[key] !== undefined)
        .sort((a, b) => (a[key] as number) - (b[key] as number));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    return { docs: rows.map((data) => new FakeSnapshot(data)) };
  }
  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.db, `${this.prefix}/${id}`);
  }
}

class FakeTransaction {
  constructor(private readonly writes: (() => void)[]) {}
  get(ref: FakeDocRef) {
    return ref.get();
  }
  set(ref: FakeDocRef, data: Data): void {
    this.writes.push(() => ref.db.store.set(ref.path, structuredClone(data)));
  }
}

class FakeFirestore {
  readonly store = new Map<string, Data>();
  private lock: Promise<unknown> = Promise.resolve();

  collection(name: string): FakeQuery {
    return new FakeQuery(this, name);
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
  return { fake, store: new FirestoreReportStore(fake as unknown as Firestore) };
}

describeReportStoreContract("Firestore (fake)", () => makeStore().store);

describe("FirestoreReportStore (PIN-269)", () => {
  it("mirrors deleteAt as the dueAt query key while open, and drops it on a decision", async () => {
    const { fake, store } = makeStore();
    await store.create({
      id: "rep-1",
      boardId: "board-slug-00000000001",
      reference: "0123456789abcdef",
      scope: "element",
      targetId: "el-1",
      reason: "likeness",
      reporterKind: "visitor",
      severity: "normal",
      createdAt: 1_000,
      status: "open",
      deleteAt: 5_000,
      held: { elementIds: ["el-1"], sceneIds: [], boardReview: false, storageHold: false },
    });
    expect(fake.store.get("reports/rep-1")).toMatchObject({ deleteAt: 5_000, dueAt: 5_000 });
    expect(await store.get("rep-1")).not.toHaveProperty("dueAt");
    await store.decide("rep-1", { status: "dismissed", decidedAt: 2_000 });
    const decided = fake.store.get("reports/rep-1");
    expect(decided).toMatchObject({ deleteAt: 5_000, status: "dismissed" });
    expect(decided).not.toHaveProperty("dueAt");
  });

  it("a report without a deadline carries no query key", async () => {
    const { fake, store } = makeStore();
    await store.create({
      id: "rep-2",
      boardId: "board-slug-00000000001",
      reference: "0123456789abcdef",
      scope: "board",
      reason: "inappropriate",
      reporterKind: "participant",
      severity: "normal",
      createdAt: 1_000,
      status: "open",
      held: { elementIds: [], sceneIds: [], boardReview: true, storageHold: false },
    });
    expect(fake.store.get("reports/rep-2")).not.toHaveProperty("dueAt");
  });
});
