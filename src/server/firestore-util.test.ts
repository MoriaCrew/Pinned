import { describe, expect, it } from "vitest";
import { toFirestoreData } from "./firestore-util";

describe("toFirestoreData", () => {
  it("drops undefined fields and keeps the rest", () => {
    const out = toFirestoreData({ a: 1, b: undefined, c: { d: "x", e: undefined } });
    expect(out).toEqual({ a: 1, c: { d: "x" } });
    expect("b" in out).toBe(false);
  });

  it("returns a detached copy", () => {
    const source = { nested: { n: 1 } };
    const out = toFirestoreData(source);
    expect(out).toEqual(source);
    expect(out.nested).not.toBe(source.nested);
  });
});
