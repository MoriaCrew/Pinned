import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { chipsCacheKey, chipsCacheKeyBase } from "../domain/chips";
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

const LABELS = ["Orange Tabby Cat", "Teal Mug"];

describe("FirestoreChipsCacheStore (PIN-75, fake Firestore)", () => {
  it("round-trips one aiCache doc addressed by the version + language + label-set hash", async () => {
    const fake = new FakeFirestore();
    const cache = new FirestoreChipsCacheStore(fake as unknown as Firestore);
    const key = chipsCacheKey(LABELS, { locale: "fr", promptVersion: "chips.v2" });
    expect(await cache.get(key)).toBeNull();

    await cache.put({
      key,
      chips: ["en train de faire la sieste au soleil"],
      promptVersion: "chips.v2",
      locale: "fr",
      createdAt: 123,
    });
    expect([...fake.store.keys()]).toEqual([`aiCache/${chipsCacheDocId(key)}`]);
    expect(await cache.get(key)).toEqual({
      key,
      chips: ["en train de faire la sieste au soleil"],
      promptVersion: "chips.v2",
      locale: "fr",
      createdAt: 123,
    });
    // PIN-214: another language is another doc, so it misses.
    expect(await cache.get(chipsCacheKey(LABELS, { locale: "de", promptVersion: "chips.v2" }))).toBeNull();
  });

  it("rejects malformed, key-mismatched or language-less docs as a miss", async () => {
    const fake = new FakeFirestore();
    const cache = new FirestoreChipsCacheStore(fake as unknown as Firestore);
    const key = chipsCacheKey(["Teal Mug"], { locale: "en", promptVersion: "chips.v2" });
    const path = `aiCache/${chipsCacheDocId(key)}`;
    fake.store.set(path, {
      key: "someone else",
      chips: ["x"],
      promptVersion: "chips.v2",
      locale: "en",
      createdAt: 1,
    });
    expect(await cache.get(key)).toBeNull();
    fake.store.set(path, { key, chips: "nope" });
    expect(await cache.get(key)).toBeNull();
    fake.store.set(path, { key, chips: ["x"], promptVersion: "chips.v2", locale: "xx", createdAt: 1 });
    expect(await cache.get(key)).toBeNull();
    // A chips.v1 doc (label-set key, no language) is never served.
    const v1Key = chipsCacheKeyBase(["Teal Mug"]);
    fake.store.set(`aiCache/${chipsCacheDocId(v1Key)}`, { key: v1Key, chips: ["x"], promptVersion: "chips.v1", createdAt: 1 });
    expect(await cache.get(v1Key)).toBeNull();
  });
});
