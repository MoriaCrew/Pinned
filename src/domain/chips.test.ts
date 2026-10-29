import { describe, expect, it } from "vitest";
import {
  chipsCacheKeyBase,
  isChipsCacheFresh,
  normalizeChipLabels,
} from "./chips";

describe("generated chips label sets (PIN-75)", () => {
  it("normalizes case, whitespace, order and duplicates into one key", () => {
    expect(normalizeChipLabels(["  Teal   Mug ", "CAT", "cat", ""])).toEqual([
      "cat",
      "teal mug",
    ]);
    expect(chipsCacheKeyBase(["Cat", "teal mug"])).toBe(
      chipsCacheKeyBase([" TEAL  MUG", "cat "]),
    );
    expect(chipsCacheKeyBase(["cat", "mug"])).not.toBe(
      chipsCacheKeyBase(["cat mug"]),
    );
  });

  it("is fresh strictly inside the Policy TTL", () => {
    const createdAt = 1_000_000;
    const ttlMs = 24 * 60 * 60 * 1000;
    expect(isChipsCacheFresh({ createdAt }, createdAt + ttlMs - 1, 24)).toBe(true);
    expect(isChipsCacheFresh({ createdAt }, createdAt + ttlMs, 24)).toBe(false);
    expect(isChipsCacheFresh({ createdAt }, createdAt, 24)).toBe(true);
  });
});
