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
      req({ participantId: "p1", participantPhotoCap: 20, boardId: "b1", boardCap: 40 }),
    );
    const r2 = await store.reserve(
      req({ participantId: "p1", participantPhotoCap: 20, boardId: "b1", boardCap: 40 }),
    );
    expect(r1.ok && r2.ok).toBe(true);
    expect([...fake.store.keys()]).toEqual([`aiBudget/${DAY}`]);
    expect(fake.store.get(`aiBudget/${DAY}`)).toEqual({
      dayBucket: DAY,
      calls: 2,
      reservedMicroUsd: 20_000,
      participantPhotos: { p1: 2 },
      participantScenes: {},
      boards: { b1: 2 },
      participantSegments: {},
      participantTapNames: {},
      participantTranscriptions: {},
      hourBucket: "",
      hourReservedMicroUsd: 0,
      photos: {},
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

  it("segment caps (PIN-92): counted in their own maps, denied at cap", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreBudgetStore(fake as unknown as Firestore);
    const seg = req({
      participantId: "p1",
      participantSegmentCap: 5,
      photoId: "job-1",
      photoCap: 1,
    });
    expect((await store.reserve(seg)).ok).toBe(true);
    expect(await store.reserve(seg)).toEqual({ ok: false, reason: "photo_cap" });
    expect(
      await store.reserve(
        req({ participantId: "p1", participantSegmentCap: 1, photoId: "job-2", photoCap: 5 }),
      ),
    ).toEqual({ ok: false, reason: "participant_cap" });
    const doc = fake.store.get(`aiBudget/${DAY}`);
    expect(doc?.calls).toBe(1);
    expect(doc?.participantPhotos).toEqual({});
    expect(doc?.participantScenes).toEqual({});
    expect(doc?.participantSegments).toEqual({ p1: 1 });
    expect(doc?.photos).toEqual({ "job-1": 1 });
  });

  it("tap-name caps (PIN-117): counted in their own map, denied at cap", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreBudgetStore(fake as unknown as Firestore);
    const name = req({ participantId: "p1", participantTapNameCap: 1 });
    expect((await store.reserve(name)).ok).toBe(true);
    expect(await store.reserve(name)).toEqual({
      ok: false,
      reason: "participant_cap",
    });
    // Second allowed call for p2 exercises the increment path on
    // an existing doc.
    expect(
      (await store.reserve(req({ participantId: "p2", participantTapNameCap: 1 }))).ok,
    ).toBe(true);
    const doc = fake.store.get(`aiBudget/${DAY}`);
    expect(doc?.calls).toBe(2);
    expect(doc?.participantPhotos).toEqual({});
    expect(doc?.participantScenes).toEqual({});
    expect(doc?.participantTapNames).toEqual({ p1: 1, p2: 1 });
  });

  it("transcription caps (PIN-119): counted in their own map, denied at cap", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreBudgetStore(fake as unknown as Firestore);
    const dictation = req({ participantId: "p1", participantTranscriptionCap: 1 });
    expect((await store.reserve(dictation)).ok).toBe(true);
    expect(await store.reserve(dictation)).toEqual({ ok: false, reason: "participant_cap" });
    expect(
      (await store.reserve(req({ participantId: "p2", participantTranscriptionCap: 1 }))).ok,
    ).toBe(true);
    const doc = fake.store.get(`aiBudget/${DAY}`);
    expect(doc?.calls).toBe(2);
    expect(doc?.participantPhotos).toEqual({});
    expect(doc?.participantScenes).toEqual({});
    expect(doc?.participantTranscriptions).toEqual({ p1: 1, p2: 1 });
  });

  it("photo/scene caps (PIN-136): counted in separate maps, each denied only at its own cap", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreBudgetStore(fake as unknown as Firestore);
    const scene = req({ participantId: "p1", participantSceneCap: 1 });
    expect((await store.reserve(scene)).ok).toBe(true);
    expect(await store.reserve(scene)).toEqual({ ok: false, reason: "participant_cap" });
    // The exhausted scene quota leaves the photo quota untouched (update path).
    const photo = req({ participantId: "p1", participantPhotoCap: 1 });
    expect((await store.reserve(photo)).ok).toBe(true);
    expect(await store.reserve(photo)).toEqual({ ok: false, reason: "participant_cap" });
    const doc = fake.store.get(`aiBudget/${DAY}`);
    expect(doc?.calls).toBe(2);
    expect(doc?.participantScenes).toEqual({ p1: 1 });
    expect(doc?.participantPhotos).toEqual({ p1: 1 });
  });

  it("legacy day doc (PIN-136): missing participantPhotos/Scenes read as 0, old participants ignored", async () => {
    const fake = new FakeFirestore();
    fake.store.set(`aiBudget/${DAY}`, {
      dayBucket: DAY,
      calls: 5,
      reservedMicroUsd: 50_000,
      participants: { p1: 20 },
      boards: {},
    });
    const store = new FirestoreBudgetStore(fake as unknown as Firestore);
    // Old shared count of 20 must not block either new quota.
    expect((await store.reserve(req({ participantId: "p1", participantPhotoCap: 20 }))).ok).toBe(true);
    expect((await store.reserve(req({ participantId: "p1", participantSceneCap: 10 }))).ok).toBe(true);
    const doc = fake.store.get(`aiBudget/${DAY}`);
    expect(doc?.calls).toBe(7);
    expect(doc?.participants).toEqual({ p1: 20 }); // legacy field left untouched
    expect(doc?.participantPhotos).toEqual({ p1: 1 });
    expect(doc?.participantScenes).toEqual({ p1: 1 });
  });

  it("hourly sub-cap (PIN-240): denied at the cap in one doc, reset on hour rollover", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreBudgetStore(fake as unknown as Firestore);
    const call = (hourBucket: string) => req({ hourBucket, hourlyBudgetUsd: 0.02, estimatedCostUsd: 0.01 });
    expect((await store.reserve(call("2026-10-29T10"))).ok).toBe(true);
    expect((await store.reserve(call("2026-10-29T10"))).ok).toBe(true);
    expect(await store.reserve(call("2026-10-29T10"))).toEqual({ ok: false, reason: "hourly_budget" });
    expect([...fake.store.keys()]).toEqual([`aiBudget/${DAY}`]);
    expect(fake.store.get(`aiBudget/${DAY}`)).toMatchObject({
      hourBucket: "2026-10-29T10",
      hourReservedMicroUsd: 20_000,
      reservedMicroUsd: 20_000,
      calls: 2,
    });
    // Rolled hour resets in the same transaction/doc; daily total keeps climbing.
    expect((await store.reserve(call("2026-10-29T11"))).ok).toBe(true);
    expect(fake.store.get(`aiBudget/${DAY}`)).toMatchObject({
      hourBucket: "2026-10-29T11",
      hourReservedMicroUsd: 10_000,
      reservedMicroUsd: 30_000,
      calls: 3,
    });
    // Off (0) never denies on the hour.
    expect((await store.reserve(req({ hourBucket: "2026-10-29T11", hourlyBudgetUsd: 0, estimatedCostUsd: 0.5 }))).ok).toBe(true);
  });

  it("legacy day doc (PIN-240): missing hour fields read as none, then start tracking", async () => {
    const fake = new FakeFirestore();
    fake.store.set(`aiBudget/${DAY}`, { dayBucket: DAY, calls: 1, reservedMicroUsd: 10_000, boards: {} });
    const store = new FirestoreBudgetStore(fake as unknown as Firestore);
    expect((await store.reserve(req({ hourBucket: "2026-10-29T10", hourlyBudgetUsd: 0.02 }))).ok).toBe(true);
    expect(await store.reserve(req({ hourBucket: "2026-10-29T10", hourlyBudgetUsd: 0.02, estimatedCostUsd: 0.02 }))).toEqual({
      ok: false,
      reason: "hourly_budget",
    });
    expect(fake.store.get(`aiBudget/${DAY}`)).toMatchObject({ hourBucket: "2026-10-29T10", hourReservedMicroUsd: 10_000 });
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
    await store.reserve(req({ participantId: "p1", participantPhotoCap: 1 }));
    expect(
      await store.reserve(req({ participantId: "p1", participantPhotoCap: 1 })),
    ).toEqual({ ok: false, reason: "participant_cap" });
    // Denied reserves never wrote a doc beyond the one allowed call.
    expect(fake.store.get(`aiBudget/${DAY}`)?.calls).toBe(1);
  });
});
