#!/usr/bin/env node
/**
 * Compile the design tokens (src/ui/tokens.json) into CSS custom
 * properties (src/ui/tokens.css). tokens.json is the single source
 * of design truth (PIN-96); tokens.css is generated and checked in.
 *
 *   npm run tokens            write src/ui/tokens.css
 *   npm run tokens -- --check exit 1 if tokens.css is out of date
 *
 * Output layout: the first skin's colours + shadows on `:root` and
 * `[data-theme="<first>"]`, one `[data-theme="<id>"]` block per
 * further skin (every value re-declared so skins nest), shared
 * spacing/radius/size/tilt + `--font-<family>` on `:root`, then one
 * `@font-face` per self-hosted font file (served from /fonts).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(root, "src/ui/tokens.json");
const TARGET = resolve(root, "src/ui/tokens.css");

export function compileTokens(tokens) {
  const themes = tokens.color.themes.map((theme) => theme.id);
  const [first] = themes;
  const valueFor = (token, theme) => {
    if (typeof token.value === "string") return token.value;
    return token.value[theme] ?? token.value[first];
  };
  const out = [
    "/* Pinneds design tokens: generated from src/ui/tokens.json by scripts/build-tokens.mjs. Do not edit by hand. */",
  ];
  for (const theme of themes) {
    const selector = theme === first ? `:root,\n[data-theme="${first}"]` : `[data-theme="${theme}"]`;
    const lines = [];
    for (const family of ["color", "shadow"]) {
      for (const token of tokens[family]?.tokens ?? []) {
        lines.push(`  --${token.name}: ${valueFor(token, theme)};`);
      }
    }
    out.push(`${selector} {\n${lines.join("\n")}\n}`);
  }
  const shared = [];
  for (const family of ["spacing", "radius", "size", "tilt"]) {
    for (const token of tokens[family]?.tokens ?? []) {
      shared.push(`  --${token.name}: ${token.value};`);
    }
  }
  for (const [key, stack] of Object.entries(tokens.type.families)) {
    shared.push(`  --font-${key}: ${stack};`);
  }
  out.push(`:root {\n${shared.join("\n")}\n}`);
  for (const font of tokens.type.fonts) {
    const file = font.file.replace(/^fonts\//, "");
    out.push(
      `@font-face {\n  font-family: "${font.family}";\n  src: url("/fonts/${file}") format("woff2");\n  font-weight: ${font.weight};\n  font-style: ${font.style ?? "normal"};\n  font-display: swap;\n}`,
    );
  }
  return `${out.join("\n\n")}\n`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const css = compileTokens(JSON.parse(readFileSync(SOURCE, "utf8")));
  if (process.argv.includes("--check")) {
    const current = readFileSync(TARGET, "utf8");
    if (current !== css) {
      console.error("src/ui/tokens.css is out of date: run `npm run tokens`.");
      process.exit(1);
    }
    console.log("tokens.css is up to date.");
  } else {
    writeFileSync(TARGET, css);
    console.log(`Wrote ${TARGET}`);
  }
}
