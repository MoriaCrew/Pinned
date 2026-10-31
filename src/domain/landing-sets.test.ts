import { describe, expect, it } from "vitest";
import { LANDING_SET_ID, anotherLandingSet, pickLandingSet } from "./landing-sets";

const IDS = ["alpha", "bravo", "charlie", "delta"] as const;
const at = (n: number) => () => n;

describe("pickLandingSet (PIN-175)", () => {
  it("shows a requested set that exists, whatever the dice say", () => {
    expect(pickLandingSet(IDS, { requested: "charlie", random: at(0) })).toBe("charlie");
    expect(pickLandingSet(IDS, { requested: "alpha", random: at(0.99) })).toBe("alpha");
  });

  it("draws at random when nothing valid is requested", () => {
    expect(pickLandingSet(IDS, { random: at(0) })).toBe("alpha");
    expect(pickLandingSet(IDS, { requested: null, random: at(0.26) })).toBe("bravo");
    expect(pickLandingSet(IDS, { requested: undefined, random: at(0.99) })).toBe("delta");
  });

  it("treats an unknown, empty, differently-cased or inherited id as no request", () => {
    for (const requested of ["nope", "", "ALPHA", "__proto__", "constructor", "alpha "]) {
      expect(pickLandingSet(IDS, { requested, random: at(0.5) }), requested).toBe("charlie");
    }
  });

  it("treats a repeated ?set= (an array) as no request, even when every entry is valid", () => {
    expect(pickLandingSet(IDS, { requested: ["alpha", "bravo"], random: at(0.8) })).toBe("delta");
    expect(pickLandingSet(IDS, { requested: [], random: at(0) })).toBe("alpha");
  });

  it("covers every set and never indexes past the end", () => {
    const seen = new Set<string>();
    for (let i = 0; i < IDS.length; i++) seen.add(pickLandingSet(IDS, { random: at((i + 0.5) / IDS.length) }));
    expect([...seen].sort()).toEqual([...IDS].sort());
    expect(pickLandingSet(IDS, { random: at(1) })).toBe("delta");
  });

  it("works with a single set and refuses an empty list", () => {
    expect(pickLandingSet(["only"], { random: at(0.7) })).toBe("only");
    expect(() => pickLandingSet([], { random: at(0) })).toThrow();
  });
});

describe("anotherLandingSet (PIN-175)", () => {
  it("never returns the current set", () => {
    for (const current of IDS) {
      for (let i = 0; i < 20; i++) {
        expect(anotherLandingSet(IDS, current, at(i / 20))).not.toBe(current);
      }
    }
  });

  it("is uniform over the others", () => {
    const counts = new Map<string, number>();
    const steps = 300;
    for (let i = 0; i < steps; i++) {
      const id = anotherLandingSet(IDS, "bravo", at(i / steps));
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual(["alpha", "charlie", "delta"]);
    for (const count of counts.values()) expect(count).toBe(100);
  });

  it("with two sets always switches to the other one", () => {
    expect(anotherLandingSet(["classic", "desk"], "classic", at(0))).toBe("desk");
    expect(anotherLandingSet(["classic", "desk"], "desk", at(0.99))).toBe("classic");
  });

  it("still gives a different set when the current id is not a known one", () => {
    expect(anotherLandingSet(["classic", "desk"], "gone", at(0))).toBe("classic");
  });

  it("with a single set has nothing else to show and returns it", () => {
    expect(anotherLandingSet(["only"], "only", at(0.3))).toBe("only");
  });

  it("never indexes past the end and refuses an empty list", () => {
    expect(anotherLandingSet(IDS, "alpha", at(1))).toBe("delta");
    expect(() => anotherLandingSet([], "x", at(0))).toThrow();
  });
});

describe("LANDING_SET_ID", () => {
  it("accepts url-safe ids and rejects the rest", () => {
    for (const ok of ["classic", "ducks-holiday", "flat2", "a"]) expect(LANDING_SET_ID.test(ok), ok).toBe(true);
    for (const bad of ["", "Classic", "two words", "a--b", "-a", "a-", "a/b", "a?b", "é", "a_b"]) {
      expect(LANDING_SET_ID.test(bad), bad).toBe(false);
    }
  });
});
