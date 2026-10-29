import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { chipsCacheKeyBase } from "../domain/chips";
import { chipsCacheDocId } from "./chips-cache";
import { FirestoreChipsCacheStore } from "./firestore-chips-cache";

/** Minimal fake Firestore for direct doc get/set (no queries exist). */
class FakeDocRef {
  constructor(private readonly store: Map<string, Record<string, unknown>>, readonly path: string) {}
  async get() {
    const value = this.store.get(this.path);
    return {
      exists: value !== undefined,
      data: () => (value ? structuredClone(value) : undefined),
    };
  }
  async set(data: Record<string, unknown>) {
    this.store.set(this.path, structuredClone(data));
  }
}

class FakeFirestore {
  readonly store = new Map<string, Record<string, unknown>>();
  collection(name: string) {
    return { doc: (id: string) => new FakeDocRef(this.store, `${name}/${id}`) };
  }
}

describe("FirestoreChipsCacheStore (PIN-75, fake Firestore)", () => {
  it("round-trips one aiCache doc addressed by the label-set hash", async () => {
    const fake = new FakeFirestore();
    const cache = new FirestoreChipsCacheStore(fake as unknown as Firestore);
    const key = chipsCacheKeyBase(["Orange Tabby Cat", "Teal Mug"]);
    expect(await cache.get(key)).toBeNull();

    await cache.put({
      key,
      chips: ["napping in a sunbeam"],
      promptVersion: "chips.v1",
      createdAt: 123,
    });
    expect([...fake.store.keys()]).toEqual([`aiCache/${chipsCacheDocId(key)}`]);
    expect(await cache.get(key)).toEqual({
      key,
      chips: ["napping in a sunbeam"],
      promptVersion: "chips.v1",
      createdAt: 123,
    });
  });

  it("rejects malformed or key-mismatched docs as a miss", async () => {
    const fake = new FakeFirestore();
    const cache = new FirestoreChipsCacheStore(fake as unknown as Firestore);
    const key = chipsCacheKeyBase(["Teal Mug"]);
    fake.store.set(`aiCache/${chipsCacheDocId(key)}`, {
      key: "someone else",
      chips: ["x"],
      promptVersion: "chips.v1",
      createdAt: 1,
    });
    expect(await cache.get(key)).toBeNull();
    fake.store.set(`aiCache/${chipsCacheDocId(key)}`, { key, chips: "nope" });
    expect(await cache.get(key)).toBeNull();
  });
});
