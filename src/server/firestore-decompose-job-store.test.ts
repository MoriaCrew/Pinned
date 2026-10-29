import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import type { DecomposeJob } from "../domain/board";
import { FirestoreDecomposeJobStore } from "./firestore-decompose-job-store";

/**
 * Minimal fake Firestore (same approach as the other firestore-*
 * tests): path-keyed docs, collection groups, serialized
 * transactions. Covers only what the job store calls.
 */
type Data = Record<string, unknown>;

class FakeSnapshot {
  constructor(
    readonly ref: FakeDocRef,
    private readonly value?: Data,
  ) {}
  get id(): string {
    return this.ref.id;
  }
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
  get id(): string {
    return this.path.split("/").pop() as string;
  }
  async get(): Promise<FakeSnapshot> {
    return new FakeSnapshot(this, this.db.store.get(this.path));
  }
  async create(data: Data): Promise<void> {
    if (this.db.store.has(this.path)) {
      throw Object.assign(new Error("already exists"), { code: 6 });
    }
    this.db.store.set(this.path, structuredClone(data));
  }
  collection(name: string): FakeCollection {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }
}

class FakeQuery {
  constructor(
    protected readonly db: FakeFirestore,
    private readonly scope: { kind: "collection"; path: string } | { kind: "group"; name: string },
    private readonly filter: { field: string; value: unknown } | null = null,
  ) {}
  where(field: string, _op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.db, this.scope, { field, value });
  }
  docs(): FakeSnapshot[] {
    return [...this.db.store.entries()]
      .filter(([path]) => {
        if (this.scope.kind === "collection") {
          const prefix = `${this.scope.path}/`;
          return path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
        }
        const parts = path.split("/");
        return parts.length >= 2 && parts[parts.length - 2] === this.scope.name;
      })
      .filter(([, data]) => !this.filter || data[this.filter.field] === this.filter.value)
      .map(([path, data]) => new FakeSnapshot(new FakeDocRef(this.db, path), data));
  }
  async get(): Promise<{ docs: FakeSnapshot[] }> {
    return { docs: this.docs() };
  }
}

class FakeCollection extends FakeQuery {
  constructor(
    db: FakeFirestore,
    readonly path: string,
  ) {
    super(db, { kind: "collection", path });
  }
  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.db, `${this.path}/${id}`);
  }
}

class FakeFirestore {
  readonly store = new Map<string, Data>();
  private lock: Promise<unknown> = Promise.resolve();
  collection(name: string): FakeCollection {
    return new FakeCollection(this, name);
  }
  collectionGroup(name: string): FakeQuery {
    return new FakeQuery(this, { kind: "group", name });
  }
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.lock;
    this.lock = next;
    await previous;
    try {
      const writes: { ref: FakeDocRef; data: Data }[] = [];
      const tx = {
        get: async (target: FakeDocRef | FakeQuery) =>
          target instanceof FakeDocRef ? target.get() : target.get(),
        set: (ref: FakeDocRef, data: Data) => {
          writes.push({ ref, data });
        },
      };
      const result = await fn(tx);
      for (const write of writes) {
        this.store.set(write.ref.path, structuredClone(write.data));
      }
      return result;
    } finally {
      release();
    }
  }
}

function job(id: string, createdAt: number): DecomposeJob {
  return {
    id,
    boardId: "board-1",
    participantId: "p1",
    status: "pending",
    workingRef: `tmp/boards/board-1/jobs/${id}/working.webp`,
    promptVersion: "elements.v1",
    elementIds: [],
    pinIds: [],
    faceNote: false,
    failedConceptCount: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("FirestoreDecomposeJobStore (fake Firestore)", () => {
  it("creates, reads, claims once, updates and lists per board", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreDecomposeJobStore(db as unknown as Firestore);

    await store.create(job("job-2", 200));
    await store.create(job("job-1", 100));
    await expect(store.create(job("job-1", 300))).rejects.toThrow(RangeError);

    expect((await store.get("job-1"))?.createdAt).toBe(100);
    expect(await store.get("missing")).toBeNull();

    const claimed = await store.claim("job-1", 150);
    expect(claimed?.status).toBe("running");
    expect(claimed?.updatedAt).toBe(150);
    // Second claim loses: claim-before-call.
    expect(await store.claim("job-1", 160)).toBeNull();
    expect(await store.claim("missing", 160)).toBeNull();

    const done: DecomposeJob = {
      ...(claimed as DecomposeJob),
      status: "ready",
      pinIds: ["job-1-pin0"],
      workingDeletedAt: 170,
      updatedAt: 170,
    };
    await store.update(done);
    expect(await store.get("job-1")).toEqual(done);
    await expect(store.update(job("ghost", 1))).rejects.toThrow(RangeError);

    const listed = await store.listForBoard("board-1");
    expect(listed.map((j) => j.id)).toEqual(["job-1", "job-2"]);
    expect(await store.listForBoard("other-board")).toEqual([]);
    // Stored under the reserved boards/{slug}/jobs/{id} layout.
    expect([...db.store.keys()]).toContain("boards/board-1/jobs/job-1");
  });
});
