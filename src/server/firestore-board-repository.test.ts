import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { emptyBoardCounters } from "../domain/board";
import { describeBoardRepositoryContract } from "../domain/board-repository.contract";
import { FirestoreBoardRepository } from "./firestore-board-repository";

/**
 * Fake Firestore for boards, same approach as
 * firestore-repository.test.ts / firestore-budget-store.test.ts:
 * a path-keyed store, buffered transaction writes applied on
 * commit, transactions serialized through a lock (the observable
 * guarantee real Firestore gives via contention + retry). Adds
 * collection groups, array-contains and auto-ids, which the board
 * repository uses. No emulator: none runs in CI (AI_MOCK=1) and
 * the fake is the repo's established Firestore test double.
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
    this.applySet(data);
  }
  async set(data: Data): Promise<void> {
    this.applySet(data);
  }
  async delete(): Promise<void> {
    this.applyDelete();
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

interface Filter {
  field: string;
  op: string;
  value: unknown;
}

function matches(data: Data, filter: Filter): boolean {
  if (filter.op === "==") return data[filter.field] === filter.value;
  if (filter.op === "array-contains") {
    const v = data[filter.field];
    return Array.isArray(v) && v.includes(filter.value);
  }
  throw new Error(`fake only supports == and array-contains, got ${filter.op}`);
}

class FakeQuery {
  constructor(
    protected readonly db: FakeFirestore,
    private readonly scope: { kind: "collection"; path: string } | { kind: "group"; name: string },
    private readonly filter: Filter | null,
  ) {}
  where(field: string, op: string, value: unknown): FakeQuery {
    if (this.filter) throw new Error("fake supports one where clause");
    return new FakeQuery(this.db, this.scope, { field, op, value });
  }
  docs(): FakeSnapshot[] {
    const entries = [...this.db.store.entries()].filter(([path]) => {
      if (this.scope.kind === "collection") {
        const prefix = `${this.scope.path}/`;
        return path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
      }
      const parts = path.split("/");
      return parts.length >= 2 && parts[parts.length - 2] === this.scope.name;
    });
    return entries
      .filter(([, data]) => !this.filter || matches(data, this.filter))
      .map(
        ([path, data]) => new FakeSnapshot(new FakeDocRef(this.db, path), data),
      );
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
    super(db, { kind: "collection", path }, null);
  }
  doc(id?: string): FakeDocRef {
    return new FakeDocRef(this.db, `${this.path}/${id ?? this.db.autoId()}`);
  }
}

class FakeTransaction {
  constructor(private readonly writes: (() => void)[]) {}
  async get(
    target: FakeDocRef | FakeQuery,
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
  private lock: Promise<unknown> = Promise.resolve();
  private autoSeq = 0;

  autoId(): string {
    return `auto-${++this.autoSeq}`;
  }
  collection(name: string): FakeCollection {
    return new FakeCollection(this, name);
  }
  collectionGroup(name: string): FakeQuery {
    return new FakeQuery(this, { kind: "group", name }, null);
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
  async terminate(): Promise<void> {}
}

function makeRepo() {
  const fake = new FakeFirestore();
  return { fake, repo: new FirestoreBoardRepository(fake as unknown as Firestore) };
}

describeBoardRepositoryContract("firestore (fake)", () => makeRepo().repo);

describe("FirestoreBoardRepository layout (fake Firestore)", () => {
  const SLUG = "board-slug-00000000001";

  it("stores boards/ subcollections, strips undefined, never touches games/", async () => {
    const { fake, repo } = makeRepo();
    const gameDoc = { id: "legacy", state: "OPEN" };
    fake.store.set("games/legacy", gameDoc);

    await repo.createBoard({
      slug: SLUG,
      title: "Kitchen finds",
      counters: emptyBoardCounters(),
      createdAt: 1_000,
      version: 0,
    });
    await repo.putParticipant({
      id: "part-1",
      boardId: SLUG,
      displayName: "Aye",
      cookieSecretHash: "hash",
      createdAt: 1_100,
    });
    await repo.createElement({
      id: "el-1",
      boardId: SLUG,
      ownerId: "part-1",
      label: "teal mug",
      description: "a distressed teal mug",
      maskBox: { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.6 },
      cutoutRef: "elements/el-1/cutout.png",
      flattenedRef: "elements/el-1/flat.png",
      sourcePhotoId: "photo-1",
      faceFlag: false,
      createdAt: 1_200,
    });
    await repo.createPin({
      id: "pin-1",
      boardId: SLUG,
      elementId: "el-1",
      pinnedBy: "part-1",
      status: "pinned",
      createdAt: 1_300,
    });

    const paths = [...fake.store.keys()].sort();
    expect(paths).toContain(`boards/${SLUG}`);
    expect(paths).toContain(`boards/${SLUG}/participants/part-1`);
    expect(paths).toContain(`boards/${SLUG}/elements/el-1`);
    expect(paths).toContain(`boards/${SLUG}/pins/pin-1`);
    expect(paths.filter((p) => p.startsWith(`boards/${SLUG}/events/`))).toHaveLength(2);
    expect(paths.filter((p) => p.startsWith("games/"))).toEqual(["games/legacy"]);
    expect(fake.store.get("games/legacy")).toEqual(gameDoc);

    // Optional fields left unset never reach the store (Firestore
    // rejects undefined), and the internal _seq never leaks on reads.
    expect(fake.store.get(`boards/${SLUG}/participants/part-1`)).not.toHaveProperty("userId");
    expect(fake.store.get(`boards/${SLUG}/participants/part-1`)).not.toHaveProperty("reclaimPinHash");
    expect(await repo.getElement("el-1")).not.toHaveProperty("_seq");
    expect((await repo.listEvents(SLUG))[0]).not.toHaveProperty("_seq");
    expect((await repo.getBoard(SLUG))?.counters).toEqual({
      participantCount: 1,
      elementCount: 1,
      pinCount: 1,
      sceneCount: 0,
    });
  });

  it("createdAt ties keep append order, not id order", async () => {
    const { repo } = makeRepo();
    await repo.createBoard({
      slug: SLUG,
      title: "Ties",
      counters: emptyBoardCounters(),
      createdAt: 1_000,
      version: 0,
    });
    const element = (id: string) => ({
      id,
      boardId: SLUG,
      ownerId: "part-1",
      label: id,
      description: id,
      maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
      cutoutRef: `elements/${id}/cutout.png`,
      flattenedRef: `elements/${id}/flat.png`,
      sourcePhotoId: "photo-1",
      faceFlag: false,
      createdAt: 5_000,
    });
    await repo.createElement(element("el-z"));
    await repo.createElement(element("el-a"));
    expect((await repo.listElements(SLUG)).map((e) => e.id)).toEqual(["el-z", "el-a"]);
    expect((await repo.listEvents(SLUG)).map((e) => e.elementId)).toEqual(["el-z", "el-a"]);
  });

  it("enforces globally unique element/pin/scene ids across boards", async () => {
    const { repo } = makeRepo();
    const board = (slug: string) => ({
      slug,
      title: slug,
      counters: emptyBoardCounters(),
      createdAt: 1_000,
      version: 0,
    });
    await repo.createBoard(board(SLUG));
    await repo.createBoard(board("board-b"));
    const element = {
      id: "el-1",
      boardId: SLUG,
      ownerId: "part-1",
      label: "mug",
      description: "mug",
      maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
      cutoutRef: "elements/el-1/cutout.png",
      flattenedRef: "elements/el-1/flat.png",
      sourcePhotoId: "photo-1",
      faceFlag: false,
      createdAt: 1_200,
    };
    await repo.createElement(element);
    await expect(
      repo.createElement({ ...element, boardId: "board-b" }),
    ).rejects.toThrow(RangeError);
    const scene = {
      id: "scene-1",
      boardId: SLUG,
      createdBy: "part-1",
      elementIds: ["el-1"],
      prompt: "picnic",
      status: "ready" as const,
      promptVersion: "scene.v1",
      createdAt: 1_400,
    };
    await repo.putScene(scene);
    await expect(repo.putScene({ ...scene, boardId: "board-b" })).rejects.toThrow(RangeError);
  });
});
