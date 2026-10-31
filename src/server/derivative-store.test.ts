import { describe, expect, it } from "vitest";
import { GcsDerivativeStore, InMemoryDerivativeStore, type DerivativeStore } from "./derivative-store";

/** A bucket double with just what GcsDerivativeStore calls; it records each listing query. */
function gcsWithFakeBucket(): { store: GcsDerivativeStore; queries: unknown[]; extraNames: string[] } {
  const objects = new Map<string, Buffer>();
  const queries: unknown[] = [];
  const extraNames: string[] = [];
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
        if (!objects.delete(name)) throw gone();
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
  return { store, queries, extraNames };
}

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
