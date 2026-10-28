import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import type { ReserveRequest } from "../gateway/budget";
import { FirestoreBudgetStore } from "./firestore-budget-store";

/**
 * Minimal fake Firestore for the budget counter. It resolves
 * FieldValue.increment sentinels (NumericIncrementTransform with an
 * `operand`) and serializes transactions through a lock — the same
 * observable guarantee real Firestore gives via transaction
 * contention + retry: a loser's callback re-reads committed state.
 */
type Data = Record<string, unknown>;

function isIncrement(v: unknown): v is { operand: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { constructor?: { name?: string } }).constructor?.name ===
      "NumericIncrementTransform"
  );
}

function setPath(target: Data, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Data = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof cur[part] !== "object" || cur[part] === null) cur[part] = {};
    cur = cur[part] as Data;
  }
  const leaf = parts[parts.length - 1];
  cur[leaf] = isIncrement(value)
    ? ((cur[leaf] as number | undefined) ?? 0) + value.operand
    : structuredClone(value);
}

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
  async set(data: Data): Promise<void> {
    this.applySet(data);
  }
  applySet(data: Data): void {
    const next: Data = {};
    for (const [k, v] of Object.entries(data)) setPath(next, k, v);
    this.db.store.set(this.path, next);
  }
  applyUpdate(data: Data): void {
    const next = structuredClone(this.db.store.get(this.path) ?? {});
    for (const [k, v] of Object.entries(data)) setPath(next, k, v);
    this.db.store.set(this.path, next);
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
  update(ref: FakeDocRef, data: Data): void {
    this.writes.push(() => ref.applyUpdate(data));
  }
}

class FakeFirestore {
  readonly store = new Map<string, Data>();
  private lock: Promise<unknown> = Promise.resolve();

  collection(name: string) {
    const db = this;
    return {
      doc: (id: string) => new FakeDocRef(db, `${name}/${id}`),
    };
  }

  async runTransaction<T>(
    fn: (tx: FakeTransaction) => Promise<T>,
  ): Promise<T> {
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

const DAY = "2026-10-29";

function req(over: Partial<ReserveRequest> = {}): ReserveRequest {
  return {
    dayBucket: DAY,
    estimatedCostUsd: 0.01,
    budgetUsd: 2,
    callLimit: 200,
    ...over,
  };
}

describe("FirestoreBudgetStore (PIN-61, fake Firestore)", () => {
  it("creates ONE counter doc per day and increments it", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreBudgetStore(fake as unknown as Firestore);
    const r1 = await store.reserve(
      req({ participantId: "p1", participantCap: 20, boardId: "b1", boardCap: 40 }),
    );
    const r2 = await store.reserve(
      req({ participantId: "p1", participantCap: 20, boardId: "b1", boardCap: 40 }),
    );
    expect(r1.ok && r2.ok).toBe(true);
    expect([...fake.store.keys()]).toEqual([`aiBudget/${DAY}`]);
    expect(fake.store.get(`aiBudget/${DAY}`)).toEqual({
      dayBucket: DAY,
      calls: 2,
      reservedMicroUsd: 20_000,
      participants: { p1: 2 },
      boards: { b1: 2 },
    });
  });

  it("race: two concurrent reserves at the cap -> exactly one proceeds", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreBudgetStore(fake as unknown as Firestore);
    await store.reserve(req({ callLimit: 2 }));
    const results = await Promise.all([
      store.reserve(req({ callLimit: 2 })),
      store.reserve(req({ callLimit: 2 })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "call_limit" },
    ]);
    expect(fake.store.get(`aiBudget/${DAY}`)?.calls).toBe(2);
  });

  it("parity with the memory store: off, budget and caps deny identically", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreBudgetStore(fake as unknown as Firestore);
    expect(await store.reserve(req({ budgetUsd: 0 }))).toEqual({
      ok: false,
      reason: "off",
    });
    expect(await store.reserve(req({ estimatedCostUsd: 5 }))).toEqual({
      ok: false,
      reason: "budget",
    });
    await store.reserve(req({ participantId: "p1", participantCap: 1 }));
    expect(
      await store.reserve(req({ participantId: "p1", participantCap: 1 })),
    ).toEqual({ ok: false, reason: "participant_cap" });
    // Denied reserves never wrote a doc beyond the one allowed call.
    expect(fake.store.get(`aiBudget/${DAY}`)?.calls).toBe(1);
  });
});
