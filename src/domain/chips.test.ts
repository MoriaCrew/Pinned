import { describe, expect, it, vi } from "vitest";
import {
  FIXED_CHIP_KEYS,
  chipsCacheKey,
  chipsCacheKeyBase,
  fixedSceneChips,
  isChipsCacheFresh,
  normalizeChipLabels,
} from "./chips";

// PIN-214: a stand-in French catalog (never edit fr.json by hand) so
// the fixed chips' language is visible before the translate run.
vi.mock("../i18n/messages/fr.json", () => ({
  default: {
    "make.chip.picnic": "sur une nappe de pique-nique au soleil",
    "make.chip.museum": "dans un tout petit musée",
  },
}));

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

describe("chips cache key: prompt version + language + label set (PIN-214)", () => {
  const v2fr = { locale: "fr", promptVersion: "chips.v2" } as const;

  it("varies by language and by prompt version, not by label order or case", () => {
    const key = chipsCacheKey(["Cat", "teal mug"], v2fr);
    expect(key).toBe(chipsCacheKey([" TEAL  MUG", "cat "], v2fr));
    expect(key).not.toBe(chipsCacheKey(["Cat", "teal mug"], { ...v2fr, locale: "de" }));
    expect(key).not.toBe(chipsCacheKey(["Cat", "teal mug"], { ...v2fr, locale: "en" }));
    expect(key).not.toBe(chipsCacheKey(["Cat", "teal mug"], { ...v2fr, promptVersion: "chips.v1" }));
    expect(key).toBe(["chips.v2", "fr", chipsCacheKeyBase(["cat", "teal mug"])].join("\n"));
  });

  it("is empty when no label survives, so nothing is cached", () => {
    expect(chipsCacheKey(["  ", ""], v2fr)).toBe("");
  });
});

describe("fixed idea chips in the viewer's language (PIN-214)", () => {
  it("English text comes from en.json, capped by the Policy count", () => {
    expect(fixedSceneChips("en", 4)).toEqual([
      "on a sunny picnic blanket",
      "in a tiny museum",
      "floating in space",
      "at a birthday party",
    ]);
    expect(fixedSceneChips("en", 2)).toHaveLength(2);
    expect(fixedSceneChips("en", 0)).toEqual([]);
    expect(fixedSceneChips("en", FIXED_CHIP_KEYS.length + 3)).toHaveLength(FIXED_CHIP_KEYS.length);
  });

  it("follows the locale, key by key, with English for untranslated keys", () => {
    expect(fixedSceneChips("fr", 3)).toEqual([
      "sur une nappe de pique-nique au soleil",
      "dans un tout petit musée",
      "floating in space",
    ]);
  });
});
