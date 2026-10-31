import { describe, expect, it } from "vitest";
import tokens from "../ui/tokens.json";
import {
  DEFAULT_SKIN,
  LEGACY_THEME_SKINS,
  SKINS,
  SKIN_IDS,
  getSkin,
  isPlusSkinId,
  isSkinId,
  personColorIndex,
  skinForTheme,
  stickerTilt,
} from "./skins";
import { BOARD_THEMES } from "./board-themes";

describe("skins catalogue (PIN-96)", () => {
  it("lists every skin the tokens define, in token order, Paper first", () => {
    expect(tokens.color.themes.map((theme) => theme.id)).toEqual([...SKIN_IDS]);
    expect(SKINS.map((skin) => skin.id)).toEqual([...SKIN_IDS]);
    expect(DEFAULT_SKIN).toBe("paper");
  });

  it("marks Darkroom, Postcard and Marigold as Plus, Marigold as seasonal", () => {
    expect(SKINS.filter((skin) => skin.plus).map((skin) => skin.id)).toEqual([
      "darkroom",
      "postcard",
      "marigold",
    ]);
    expect(getSkin("marigold").seasonal).toBe(true);
    expect(isPlusSkinId("darkroom")).toBe(true);
    expect(isPlusSkinId("paper")).toBe(false);
    expect(isPlusSkinId("nope")).toBe(false);
  });

  it("validates skin ids", () => {
    expect(isSkinId("zine")).toBe(true);
    expect(isSkinId("gran")).toBe(false);
    expect(isSkinId(undefined)).toBe(false);
    expect(isSkinId(42)).toBe(false);
  });

  it("maps every first-generation theme onto a free skin; unknown → Paper", () => {
    for (const theme of BOARD_THEMES) {
      const skin = skinForTheme(theme.id);
      expect(LEGACY_THEME_SKINS[theme.id]).toBe(skin);
      expect(getSkin(skin).plus).toBe(false);
    }
    expect(skinForTheme("postcard")).toBe("postcard");
    expect(skinForTheme(undefined)).toBe("paper");
    expect(skinForTheme(null)).toBe("paper");
    expect(skinForTheme("toString")).toBe("paper");
    expect(skinForTheme("unknown-look")).toBe("paper");
  });

  it("gives a person a stable colour index 1–6", () => {
    const index = personColorIndex("participant-abc");
    expect(personColorIndex("participant-abc")).toBe(index);
    expect(index).toBeGreaterThanOrEqual(1);
    expect(index).toBeLessThanOrEqual(6);
    const seen = new Set(Array.from({ length: 60 }, (_, i) => personColorIndex(`p-${i}`)));
    expect(seen.size).toBe(6);
  });

  it("gives a sticker a stable tilt factor in [-1, 1]", () => {
    expect(stickerTilt("teal-mug")).toBe(stickerTilt("teal-mug"));
    expect(stickerTilt(null)).toBe(0);
    for (let i = 0; i < 50; i++) {
      const t = stickerTilt(`thing-${i}`);
      expect(t).toBeGreaterThanOrEqual(-1);
      expect(t).toBeLessThanOrEqual(1);
    }
  });
});
