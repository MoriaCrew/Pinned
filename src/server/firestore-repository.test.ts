import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { FirestoreGameRepository } from "./firestore-repository";

type Data = Record<string, unknown>;

class FakeSnapshot {
  constructor(private readonly value?: Data) {}

  get exists(): boolean {
    return this.value !== undefined;
  }

  data(): Data | undefined {
    return this.value;
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
    this.db.store.set(this.path, data);
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

  where(field: string, op: string, value: unknown): FakeQuery {
    if (op !== "==") throw new Error("fake only supports ==");
    return new FakeQuery(this.db, this.path, field, value);
  }

  directDocs(): Data[] {
    const prefix = `${this.path}/`;
    return [...this.db.store.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map(([, data]) => data);
  }
}

class FakeQuery {
  constructor(
    private readonly db: FakeFirestore,
    private readonly path: string,
    private readonly field: string,
    private readonly value: unknown,
  ) {}

  async get(): Promise<{ docs: FakeSnapshot[] }> {
    const collection = new FakeCollection(this.db, this.path);
    return {
      docs: collection
        .directDocs()
        .filter((data) => data[this.field] === this.value)
        .map((data) => new FakeSnapshot(data)),
    };
  }
}

class FakeFirestore {
  readonly store = new Map<string, Data>();

  collection(name: string): FakeCollection {
    return new FakeCollection(this, name);
  }

  async terminate(): Promise<void> {}
}

describe("FirestoreGameRepository (fake Firestore, PIN-93)", () => {
  it("appends AI logs under aiCallLogs and filters by day bucket", async () => {
    const fake = new FakeFirestore();
    const repo = new FirestoreGameRepository(fake as unknown as Firestore);
    const base = {
      operation: "nameObject",
      model: "muse-spark-1.3",
      latencyMs: 12,
      outcome: "ok" as const,
      createdAt: 1,
    };
    await repo.appendAiCallLog({ ...base, id: "today", dayBucket: "2026-10-27" });
    await repo.appendAiCallLog({ ...base, id: "tomorrow", dayBucket: "2026-10-28" });
    expect(fake.store.get("aiCallLogs/today")).toMatchObject({ dayBucket: "2026-10-27" });
    // Optional fields left undefined are stripped before the write.
    expect(fake.store.get("aiCallLogs/today")).not.toHaveProperty("gameId");
    expect((await repo.listAiCallLogs("2026-10-27")).map((log) => log.id)).toEqual(["today"]);
    expect(await repo.listAiCallLogs("2026-10-29")).toEqual([]);
  });

  it("PIN-137: writes expireAtTs Timestamp mirror, strips it on read, normalizes old rows", async () => {
    const fake = new FakeFirestore();
    const repo = new FirestoreGameRepository(fake as unknown as Firestore);
    await repo.appendAiCallLog({
      id: "v2", operation: "segment", model: "sam-3.1", latencyMs: 1,
      outcome: "ok", dayBucket: "2026-10-27", createdAt: 1_000,
      boardId: "synthetic-board-fs", expireAt: 1_000 + 90 * 86_400_000,
    });
    const stored = fake.store.get("aiCallLogs/v2")!;
    expect(stored.expireAtTs).toMatchObject({ toMillis: expect.any(Function) });
    expect((stored.expireAtTs as { toMillis(): number }).toMillis()).toBe(1_000 + 90 * 86_400_000);
    // Seed an old-shape doc directly (pre-v2 write).
    fake.store.set("aiCallLogs/old", {
      id: "old", operation: "nameObject", model: "m", latencyMs: 1,
      outcome: "ok", dayBucket: "2026-10-27", createdAt: 5,
      gameId: "synthetic-board-fs", costEstimateUsd: 0.0025,
    });
    const rows = await repo.listAiCallLogs("2026-10-27");
    const v2 = rows.find((r) => r.id === "v2")!;
    expect(v2).not.toHaveProperty("expireAtTs");
    const old = rows.find((r) => r.id === "old")!;
    expect(old.boardId).toBe("synthetic-board-fs");
    expect(old.costMicroUsdEst).toBe(2500);
  });
});
