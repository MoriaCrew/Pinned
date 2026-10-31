import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import tokens from "./tokens.json";

/**
 * Design tokens guard (PIN-96). Every skin must keep its text
 * readable (WCAG 2: 4.5:1 for text, 3:1 for control edges, focus
 * rings and accent fills against the ground), and the generated
 * tokens.css must match tokens.json.
 */

type ColorToken = { name: string; value: string | Record<string, string> };

const colorTokens = tokens.color.tokens as ColorToken[];
const themes = tokens.color.themes.map((theme) => theme.id);
const first = themes[0];

function color(name: string, theme: string): string {
  const token = colorTokens.find((t) => t.name === name);
  if (!token) throw new Error(`missing token ${name}`);
  const value = typeof token.value === "string" ? token.value : token.value[theme] ?? token.value[first];
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name}/${theme} is not an opaque hex: ${value}`);
  return value;
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_ON_GROUNDS: [string, string[]][] = [
  ["ink", ["surface", "surface-raised", "surface-sunk"]],
  ["ink-muted", ["surface", "surface-raised"]],
  ["accent-text", ["surface", "surface-raised"]],
  ["danger", ["surface", "surface-raised"]],
];
const MARKS_ON_GROUNDS: [string, string[]][] = [
  ["line-strong", ["surface", "surface-raised"]],
  ["focus", ["surface", "surface-raised"]],
  ["accent", ["surface", "surface-raised"]],
];
const TEXT_ON_FILLS: [string, string][] = [
  ["on-accent", "accent"],
  ["on-mark", "mark"],
  ...[1, 2, 3, 4, 5, 6].map((n): [string, string] => ["on-person", `person-${n}`]),
];

describe("design tokens (PIN-96)", () => {
  it.each(themes)("%s keeps every text pair at 4.5:1 and every mark at 3:1", (theme) => {
    const failures: string[] = [];
    for (const [fg, grounds] of TEXT_ON_GROUNDS) {
      for (const bg of grounds) {
        const ratio = contrast(color(fg, theme), color(bg, theme));
        if (ratio < 4.5) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
      }
    }
    for (const [fg, grounds] of MARKS_ON_GROUNDS) {
      for (const bg of grounds) {
        const ratio = contrast(color(fg, theme), color(bg, theme));
        if (ratio < 3) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
      }
    }
    for (const [fg, bg] of TEXT_ON_FILLS) {
      const ratio = contrast(color(fg, theme), color(bg, theme));
      if (ratio < 4.5) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it("keeps muted ink readable on the darkroom print paper (the Nº under the picture)", () => {
    // Darkroom prints are drawn on surface-sunk, which the pair list above does not cover.
    expect(contrast(color("ink-muted", "darkroom"), color("surface-sunk", "darkroom"))).toBeGreaterThanOrEqual(4.5);
  });

  it("defines every colour role in every skin", () => {
    for (const token of colorTokens) {
      if (typeof token.value === "string") continue;
      for (const theme of themes) expect(token.value[theme], `${token.name}/${theme}`).toBeTruthy();
    }
  });

  it("ships a font file for every self-hosted face", async () => {
    const { existsSync } = await import("node:fs");
    for (const font of tokens.type.fonts) {
      expect(existsSync(path.resolve(__dirname, "../../public", font.file)), font.file).toBe(true);
    }
  });

  it("keeps src/ui/tokens.css in sync with tokens.json", () => {
    const script = path.resolve(__dirname, "../../scripts/build-tokens.mjs");
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
