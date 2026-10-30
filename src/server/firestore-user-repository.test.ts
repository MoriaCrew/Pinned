import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { describeUserRepositoryContract } from "../domain/user-repository.contract";
import { FirestoreUserRepository } from "./firestore-user-repository";

/**
 * Minimal fake Firestore for doc get/set/delete + whole-subcollection
 * reads (the only shapes FirestoreUserRepository uses — no
 * queries, so no index). Docs live in one path-keyed map.
 */
type DocData = Record<string, unknown>;

class FakeDocRef {
  constructor(
    private readonly store: Map<string, DocData>,
    readonly path: string,
    readonly id: string,
  ) {}

  collection(name: string) {
    return new FakeCollectionRef(this.store, `${this.path}/${name}`);
  }

  async get() {
    const value = this.store.get(this.path);
    return {
      exists: value !== undefined,
      ref: this,
      data: () => (value ? structuredClone(value) : undefined),
    };
  }

  async set(data: DocData) {
    this.store.set(this.path, structuredClone(data));
  }

  async delete() {
    this.store.delete(this.path);
  }
}

class FakeCollectionRef {
  constructor(
    private readonly store: Map<string, DocData>,
    readonly path: string,
  ) {}

  doc(id: string) {
    return new FakeDocRef(this.store, `${this.path}/${id}`, id);
  }

  async get() {
    const prefix = `${this.path}/`;
    const docs = [...this.store.entries()]
      .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
      .map(([key, value]) => ({
        ref: new FakeDocRef(this.store, key, key.slice(prefix.length)),
        data: () => structuredClone(value),
      }));
    return { docs };
  }
}

class FakeFirestore {
  readonly store = new Map<string, DocData>();
  collection(name: string) {
    return new FakeCollectionRef(this.store, name);
  }
}

function makeRepo() {
  const fake = new FakeFirestore();
  return {
    fake,
    repo: new FirestoreUserRepository(fake as unknown as Firestore),
  };
}

describeUserRepositoryContract("firestore (fake)", () => makeRepo().repo);

describe("FirestoreUserRepository layout (fake Firestore)", () => {
  it("writes users/{uid} + users/{uid}/boards/{slug} and strips _seq on read", async () => {
    const { fake, repo } = makeRepo();
    await repo.putUser({
      uid: "synthetic-user-1",
      displayName: "Test Person",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await repo.putUserBoard("synthetic-user-1", {
      boardId: "board-slug-00000000001",
      participantId: "part-1",
      claimedAt: 2_000,
      updatedAt: 2_000,
    });
    expect([...fake.store.keys()].sort()).toEqual([
      "users/synthetic-user-1",
      "users/synthetic-user-1/boards/board-slug-00000000001",
    ]);
    // No email is ever part of the stored profile shape (PIN-83).
    expect(fake.store.get("users/synthetic-user-1")).not.toHaveProperty("email");
    expect(
      fake.store.get("users/synthetic-user-1/boards/board-slug-00000000001"),
    ).toHaveProperty("_seq");
    expect(await repo.getUserBoard("synthetic-user-1", "board-slug-00000000001")).toEqual({
      boardId: "board-slug-00000000001",
      participantId: "part-1",
      claimedAt: 2_000,
      updatedAt: 2_000,
    });
  });
});
