import { describe, expect, it } from "vitest";
import {
  BOARD_THEMES,
  getBoardTheme,
  isBoardThemeId,
  playerColorFor,
  storedThemeId,
} from "./board-themes";

describe("board themes (PIN-52)", () => {
  it("ships 8 unique, complete themes carrying the PIN-41 art ids", () => {
    expect(BOARD_THEMES).toHaveLength(8);
    expect(new Set(BOARD_THEMES.map((theme) => theme.id)).size).toBe(8);
    for (const theme of BOARD_THEMES) {
      expect(theme.label.length).toBeGreaterThan(0);
      expect(theme.image).toBe(`/themes/${theme.id}.webp`);
      expect(theme.tokens.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(theme.tokens.paper).toMatch(/^#[0-9a-f]{6}$/i);
      expect(isBoardThemeId(theme.id)).toBe(true);
      expect(getBoardTheme(theme.id)).toBe(theme);
    }
    expect(getBoardTheme("nope")).toBeNull();
    expect(isBoardThemeId("nope")).toBe(false);
  });

  it("accepts design-system skin ids as stored looks (PIN-96)", () => {
    for (const id of ["paper", "cork", "fridge", "zine", "darkroom", "postcard", "marigold"]) {
      expect(isBoardThemeId(id)).toBe(true);
      expect(getBoardTheme(id)).toBeNull();
    }
  });

  it("reads the pre-pivot presetId as the theme id", () => {
    expect(storedThemeId({ presetId: "gran" })).toBe("gran");
    expect(storedThemeId({ themeId: "cat", presetId: "gran" })).toBe("cat");
    expect(storedThemeId({})).toBeUndefined();
  });

  it("gives a player a stable color from the palette", () => {
    expect(playerColorFor("player-1")).toBe(playerColorFor("player-1"));
    expect(playerColorFor("player-1")).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
