import { describe, expect, it } from "vitest";
import { GcsDerivativeStore, InMemoryDerivativeStore, type DerivativeStore } from "./derivative-store";

/** A bucket double with just what GcsDerivativeStore calls; it records each listing query. */
function gcsWithFakeBucket(): {
  store: GcsDerivativeStore;
  queries: unknown[];
  extraNames: string[];
  holds: Map<string, boolean>;
} {
  const objects = new Map<string, Buffer>();
  const queries: unknown[] = [];
  const extraNames: string[] = [];
  const holds = new Map<string, boolean>();
  const gone = () => Object.assign(new Error("No such object"), { code: 404 });
  const bucket = {
    file: (name: string) => ({
      save: async (bytes: Buffer) => void objects.set(name, bytes),
      download: async () => {
        const bytes = objects.get(name);
        if (!bytes) throw gone();
        return [bytes];
      },
      delete: async () => {
        if (holds.get(name)) throw Object.assign(new Error("Object is under active Temporary hold"), { code: 403 });
        if (!objects.delete(name)) throw gone();
      },
      setMetadata: async (meta: { temporaryHold?: boolean }) => {
        if (!objects.has(name)) throw gone();
        holds.set(name, meta.temporaryHold === true);
      },
    }),
    getFiles: async (query: { prefix: string }) => {
      queries.push(query);
      const names = [...objects.keys()].filter((name) => name.startsWith(query.prefix));
      return [[...names, ...extraNames].map((name) => ({ name }))];
    },
  };
  const store = new GcsDerivativeStore("synthetic-bucket", null);
  Object.assign(store, { storage: { bucket: () => bucket } });
  return { store, queries, extraNames, holds };
}

describe.each([
  ["in-memory", (): DerivativeStore => new InMemoryDerivativeStore()],
  ["GCS (fake bucket)", (): DerivativeStore => gcsWithFakeBucket().store],
])("DerivativeStore.setHold (PIN-269): %s", (_name, make) => {
  it("a held object refuses deletion until released; a missing object is a no-op", async () => {
    const store = make();
    const ref = "elements/boards/b1/e1/cutout.png";
    await store.put(ref, Buffer.from("png"), "image/png");
    await store.setHold(ref, true);
    await expect(store.delete(ref)).rejects.toThrow();
    expect(await store.get(ref)).toEqual(Buffer.from("png"));
    await store.setHold(ref, false);
    await store.delete(ref);
    expect(await store.get(ref)).toBeNull();
    await expect(store.setHold("elements/boards/b1/none/cutout.png", true)).resolves.toBeUndefined();
  });

  it("never accepts a held: ref (the hold goes on the real object)", async () => {
    const store = make();
    await expect(store.setHold("held:elements/boards/b1/e1/cutout.png", true)).rejects.toThrow("Invalid derivative");
  });
});

describe("GcsDerivativeStore.setHold (PIN-269)", () => {
  it("writes the temporaryHold flag through setMetadata", async () => {
    const { store, holds } = gcsWithFakeBucket();
    await store.put("elements/boards/b1/e1/cutout.png", Buffer.from("a"), "image/png");
    await store.setHold("elements/boards/b1/e1/cutout.png", true);
    expect(holds.get("elements/boards/b1/e1/cutout.png")).toBe(true);
    await store.setHold("elements/boards/b1/e1/cutout.png", false);
    expect(holds.get("elements/boards/b1/e1/cutout.png")).toBe(false);
  });
});

describe("InMemoryDerivativeStore.isHeld (PIN-269 test helper)", () => {
  it("reports the hold state", async () => {
    const store = new InMemoryDerivativeStore();
    await store.put("scenes/boards/b1/s1/scene.webp", Buffer.from("w"), "image/webp");
    expect(store.isHeld("scenes/boards/b1/s1/scene.webp")).toBe(false);
    await store.setHold("scenes/boards/b1/s1/scene.webp", true);
    expect(store.isHeld("scenes/boards/b1/s1/scene.webp")).toBe(true);
  });
});

describe.each([
  ["in-memory", (): DerivativeStore => new InMemoryDerivativeStore()],
  ["GCS (fake bucket)", (): DerivativeStore => gcsWithFakeBucket().store],
])("DerivativeStore.listPrefix (PIN-169): %s", (_name, make) => {
  it("lists exactly the refs under a trailing-slash prefix", async () => {
    const store = make();
    const refs = ["tmp/boards/b1/jobs/j1/working.webp", "tmp/boards/b1/jobs/j2/working.webp", "tmp/boards/b10/x.webp", "elements/boards/b1/e/cutout.png"];
    for (const ref of refs) await store.put(ref, Buffer.from(ref), "image/webp");
    expect((await store.listPrefix("tmp/boards/b1/")).sort()).toEqual(refs.slice(0, 2));
    expect(await store.listPrefix("scenes/boards/b1/")).toEqual([]);
    await store.delete(refs[0]);
    expect(await store.listPrefix("tmp/boards/b1/")).toEqual([refs[1]]);
  });

  it("refuses a prefix that is not a folder or not a valid ref", async () => {
    const store = make();
    for (const bad of ["", "/", "tmp/boards/b1", "tmp", "../tmp/", "/tmp/", "tmp//b1/", "tmp/../elements/"]) {
      await expect(store.listPrefix(bad)).rejects.toThrow("Invalid derivative");
    }
  });
});

describe("GcsDerivativeStore.listPrefix (PIN-169)", () => {
  it("asks the bucket for every page under the prefix and drops any name outside it", async () => {
    const { store, queries, extraNames } = gcsWithFakeBucket();
    await store.put("tmp/boards/b1/a.webp", Buffer.from("a"), "image/webp");
    extraNames.push("tmp/boards/b2/stray.webp");
    expect(await store.listPrefix("tmp/boards/b1/")).toEqual(["tmp/boards/b1/a.webp"]);
    expect(queries).toEqual([{ prefix: "tmp/boards/b1/", autoPaginate: true }]);
  });
});
