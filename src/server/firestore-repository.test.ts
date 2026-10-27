import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { VersionConflictError } from "../domain/repository";
import type { Game } from "../domain/types";
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

  async create(data: Data): Promise<void> {
    if (this.db.store.has(this.path)) {
      throw Object.assign(new Error("already exists"), { code: 6 });
    }
    this.db.store.set(this.path, data);
  }

  async set(data: Data): Promise<void> {
    this.db.store.set(this.path, data);
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

  where(field: string, op: string, value: unknown): FakeQuery {
    if (op !== "==") throw new Error("fake only supports ==");
    return new FakeQuery(this.db, this.path, field, value);
  }

  async get(): Promise<{ docs: FakeSnapshot[] }> {
    return { docs: this.directDocs().map((data) => new FakeSnapshot(data)) };
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

class FakeTransaction {
  async get(ref: FakeDocRef): Promise<FakeSnapshot> {
    return ref.get();
  }

  set(ref: FakeDocRef, data: Data): void {
    void ref.set(data);
  }
}

class FakeFirestore {
  readonly store = new Map<string, Data>();

  collection(name: string): FakeCollection {
    return new FakeCollection(this, name);
  }

  async runTransaction<T>(
    updateFunction: (transaction: FakeTransaction) => Promise<T>,
  ): Promise<T> {
    return updateFunction(new FakeTransaction());
  }

  async terminate(): Promise<void> {}
}

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: "slug-1",
    chainId: "chain-1",
    state: "OPEN",
    brief: "brief",
    challenge: "challenge",
    persona: { name: "H", language: "en", voiceRules: [], catchphrases: [], judgingStyle: "dry" },
    adminTokenHash: "hash",
    deadlineAt: 1_000,
    entryCount: 0,
    createdAt: 0,
    version: 0,
    ...overrides,
  };
}

describe("FirestoreGameRepository (fake Firestore)", () => {
  it("creates chains and games, stripping undefined fields", async () => {
    const fake = new FakeFirestore();
    const repo = new FirestoreGameRepository(fake as unknown as Firestore);
    await repo.createChain({ id: "chain-1", gameCount: 1, createdAt: 0 });
    await repo.createGame(makeGame());

    expect((await repo.getChain("chain-1"))?.gameCount).toBe(1);
    expect((await repo.getGame("slug-1"))?.state).toBe("OPEN");
    expect(fake.store.get("games/slug-1")).not.toHaveProperty("creatorUid");
    await expect(repo.createChain({ id: "chain-1", gameCount: 1, createdAt: 0 }))
      .rejects.toThrow(RangeError);
    await expect(repo.createGame(makeGame())).rejects.toThrow(RangeError);
  });

  it("CAS: race loser no-ops, stale version to another state conflicts", async () => {
    const repo = new FirestoreGameRepository(new FakeFirestore() as unknown as Firestore);
    await repo.createGame(makeGame());
    const first = await repo.compareAndSetGameState("slug-1", 0, "REVEAL", 10);
    const second = await repo.compareAndSetGameState("slug-1", 0, "REVEAL", 11);
    expect(first.changed).toBe(true);
    expect(second).toMatchObject({ changed: false, game: { version: 1 } });
    await expect(repo.compareAndSetGameState("slug-1", 0, "CLOSED", 12))
      .rejects.toThrow(VersionConflictError);
    await expect(repo.compareAndSetGameState("missing", 0, "REVEAL", 12))
      .rejects.toThrow(RangeError);
  });

  it("stores players and submissions as game subcollections", async () => {
    const repo = new FirestoreGameRepository(new FakeFirestore() as unknown as Firestore);
    await repo.createGame(makeGame());
    await repo.putPlayer({
      id: "player-1",
      gameId: "slug-1",
      displayName: "Robin",
      cookieSecretHash: "hash",
      roastLevel: "spicy",
      posterOptIn: true,
      createdAt: 1,
    });
    await repo.putSubmission({
      id: "submission-1",
      gameId: "slug-1",
      playerId: "player-1",
      cutoutRef: "cutouts/slug-1/submission-1.png",
      objectLabel: "red stapler",
      altLabel: "A red stapler",
      scores: null,
      reason: "",
      privateJudgement: "",
      teaser: "",
      safetyFlags: {},
      status: "active",
      judgeCount: 0,
      segmentCount: 0,
      submittedAt: 2,
      version: 0,
    });

    expect((await repo.getPlayer("slug-1", "player-1"))?.displayName).toBe("Robin");
    expect(await repo.listSubmissions("slug-1")).toHaveLength(1);
    expect(await repo.listSubmissions("other-game")).toHaveLength(0);
  });

  it("recordSubmission supersedes prior actives and counts entries in one transaction", async () => {
    const repo = new FirestoreGameRepository(new FakeFirestore() as unknown as Firestore);
    await repo.createGame(makeGame());
    const submission = (id: string, playerId: string, submittedAt: number) => ({
      id,
      gameId: "slug-1",
      playerId,
      workingRef: `tmp/games/slug-1/players/${playerId}/submissions/${id}/working.webp`,
      objectLabel: "",
      altLabel: "",
      scores: null,
      reason: "",
      privateJudgement: "",
      teaser: "",
      safetyFlags: {},
      status: "active" as const,
      judgeCount: 0,
      segmentCount: 0,
      submittedAt,
      version: 1,
    });

    const first = await repo.recordSubmission(submission("s1", "p1", 10), 10);
    expect(first).toMatchObject({ superseded: [], entryCount: 1 });
    const second = await repo.recordSubmission(submission("s2", "p2", 20), 20);
    expect(second.entryCount).toBe(2);
    const replaced = await repo.recordSubmission(submission("s3", "p1", 30), 30);
    expect(replaced.entryCount).toBe(2);
    expect(replaced.superseded.map((s) => s.id)).toEqual(["s1"]);
    expect(replaced.superseded[0]).toMatchObject({ status: "superseded", supersededAt: 30 });

    const all = await repo.listSubmissions("slug-1");
    expect(all.filter((s) => s.status === "active").map((s) => s.id).sort()).toEqual(["s2", "s3"]);
    expect((await repo.getGame("slug-1"))?.entryCount).toBe(2);
    await expect(repo.recordSubmission(submission("s9", "p9", 40), 40)).resolves.toBeTruthy();
    await expect(
      repo.recordSubmission({ ...submission("sx", "p1", 50), gameId: "missing" }, 50),
    ).rejects.toThrow(RangeError);
  });

  it("filters AI logs by day bucket", async () => {
    const repo = new FirestoreGameRepository(new FakeFirestore() as unknown as Firestore);
    const base = {
      operation: "generatePersona",
      model: "muse-spark-1.3",
      latencyMs: 12,
      outcome: "ok" as const,
      createdAt: 1,
    };
    await repo.appendAiCallLog({ ...base, id: "today", dayBucket: "2026-10-27" });
    await repo.appendAiCallLog({ ...base, id: "tomorrow", dayBucket: "2026-10-28" });
    expect((await repo.listAiCallLogs("2026-10-27")).map((log) => log.id)).toEqual(["today"]);
  });
});
