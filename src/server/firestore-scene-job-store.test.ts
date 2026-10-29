import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import type { SceneJob } from "../domain/board";
import { FirestoreSceneJobStore } from "./firestore-scene-job-store";

/**
 * Minimal fake Firestore (same approach as the other firestore-*
 * tests): path-keyed docs, serialized transactions. Covers only
 * what the board-scoped scene-job store calls — direct doc refs
 * and one subcollection read, no collection-group query.
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
    const docs = [...this.db.store.entries()]
      .filter(
        ([path]) =>
          path.startsWith(prefix) && !path.slice(prefix.length).includes("/"),
      )
      .map(([path, data]) => new FakeSnapshot(new FakeDocRef(this.db, path), data));
    return { docs };
  }
}

class FakeFirestore {
  readonly store = new Map<string, Data>();
  private lock: Promise<unknown> = Promise.resolve();
  collection(name: string): FakeCollection {
    return new FakeCollection(this, name);
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
        get: async (target: FakeDocRef) => target.get(),
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

function job(id: string, createdAt: number): SceneJob {
  return {
    id,
    boardId: "board-1",
    participantId: "p1",
    elementIds: ["el1"],
    prompt: "on a sunny picnic blanket",
    status: "pending",
    promptVersion: "scene.v1",
    createdAt,
    updatedAt: createdAt,
  };
}

describe("FirestoreSceneJobStore (fake Firestore)", () => {
  it("creates, reads, claims once, updates and lists per board", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreSceneJobStore(db as unknown as Firestore);

    await store.create(job("scene-2", 200));
    await store.create(job("scene-1", 100));
    await expect(store.create(job("scene-1", 300))).rejects.toThrow(RangeError);

    expect((await store.get("board-1", "scene-1"))?.createdAt).toBe(100);
    expect(await store.get("board-1", "missing")).toBeNull();
    expect(await store.get("other-board", "scene-1")).toBeNull();

    const claimed = await store.claim("board-1", "scene-1", 150);
    expect(claimed?.status).toBe("running");
    expect(claimed?.updatedAt).toBe(150);
    // Second claim loses: claim-before-call.
    expect(await store.claim("board-1", "scene-1", 160)).toBeNull();
    expect(await store.claim("board-1", "missing", 160)).toBeNull();

    const done: SceneJob = {
      ...(claimed as SceneJob),
      status: "ready",
      imageRef: "scenes/boards/board-1/scene-1/scene.png",
      costUsd: 0.017,
      updatedAt: 170,
    };
    await store.update(done);
    expect(await store.get("board-1", "scene-1")).toEqual(done);
    await expect(store.update(job("ghost", 1))).rejects.toThrow(RangeError);

    const listed = await store.listForBoard("board-1");
    expect(listed.map((j) => j.id)).toEqual(["scene-1", "scene-2"]);
    expect(await store.listForBoard("other-board")).toEqual([]);
    // Board-scoped layout boards/{slug}/sceneJobs/{id}.
    expect([...db.store.keys()]).toContain("boards/board-1/sceneJobs/scene-1");
  });
});
