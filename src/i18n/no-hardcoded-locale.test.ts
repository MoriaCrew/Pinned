import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EN_ONLY_FILES } from "./en-only-files";

// Guard (PIN-190, docs/18-i18n.md): UI text follows the user's
// language, so new code never pins English with t("en", …).
const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");
const HARD_CODED_EN = /\b(?:t|tf|tCount)\(\s*["']en["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const offenders = sourceFiles(SRC)
  .filter((file) => HARD_CODED_EN.test(readFileSync(file, "utf8")))
  .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
  .sort();

describe("no hard-coded English locale (PIN-190)", () => {
  it("only listed files call t(\"en\", …)", () => {
    const unlisted = offenders.filter((file) => !EN_ONLY_FILES.includes(file));
    expect(
      unlisted,
      'These files call t("en", …). Use useLocale() from src/i18n/client (client components) ' +
        "or await getLocale() from src/i18n/server (server), see docs/18-i18n.md",
    ).toEqual([]);
  });

  it("has no stale entries", () => {
    const stale = EN_ONLY_FILES.filter((file) => !offenders.includes(file));
    expect(
      stale,
      "These files no longer hard-code English: delete them from src/i18n/en-only-files.ts",
    ).toEqual([]);
  });
});
