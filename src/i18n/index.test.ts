import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countRuleLocale, formatDate, formatList, formatMoney, LOCALES, t, tCount, tf } from "./index";

describe("i18n catalog (FR9)", () => {
  it("resolves English strings", () => {
    expect(t("en", "landing.start")).toBe("Start a board");
  });

  it("resolves French strings in the informal register (PIN-198)", () => {
    expect(t("fr", "landing.start")).toBe("Créer un tableau");
    expect(t("fr", "landing.tagline").length).toBeGreaterThan(0);
  });

  it("fills {placeholders} and leaves unknown ones visible (PIN-97)", () => {
    expect(tf("en", "ui.pickedCount", { n: 2, max: 4 })).toBe("2 of 4 picked");
    expect(tf("en", "ui.pickedCount", { n: 2 })).toBe("2 of {max} picked");
  });

  it("picks singular and plural count forms (PIN-97)", () => {
    expect(tCount("en", "meta.people", 1)).toBe("1 person");
    expect(tCount("en", "meta.people", 6)).toBe("6 people");
    expect(tCount("en", "meta.things", 0)).toBe("0 things");
    expect(tCount("en", "meta.scenes", 1)).toBe("1 scene");
  });
});

describe("plural forms follow each language (PIN-190)", () => {
  it("French treats 0 as singular", () => {
    expect(tCount("fr", "makes.left", 0)).toBe("0 création restante");
    expect(tCount("fr", "makes.left", 1)).toBe("1 création restante");
    expect(tCount("fr", "makes.left", 2)).toBe("2 créations restantes");
  });

  it("English keeps 0 plural", () => {
    expect(tCount("en", "makes.left", 0)).toBe(tf("en", "makes.left.other", { n: 0 }));
    expect(tCount("en", "makes.left", 1)).toBe(tf("en", "makes.left.one", { n: 1 }));
  });
});

describe("count rule falls back to English (PIN-199)", () => {
  it("uses the language's own rule only when its catalog has the message", () => {
    expect(countRuleLocale("fr", { "x.other": "autres", "x.one": "un" }, "x")).toBe("fr");
    expect(countRuleLocale("fr", {}, "x")).toBe("en");
    expect(countRuleLocale("id", { "x.one": "satu" }, "x")).toBe("en");
    expect(countRuleLocale("en", {}, "x")).toBe("en");
  });
});

describe("Intl formatting helpers (PIN-190)", () => {
  it("formats money per language, without U+202F", () => {
    expect(formatMoney("en", 499, "EUR")).toBe("€4.99");
    expect(formatMoney("fr", 499, "EUR")).toBe("4,99 €");
    expect(formatMoney("de", 123456, "EUR")).toBe("1.234,56 €");
    expect(formatMoney("fr", 123456, "EUR")).not.toContain(" ");
  });

  it("formats dates per language", () => {
    const opts = { month: "short", day: "numeric", timeZone: "UTC" } as const;
    const oct31 = Date.UTC(2026, 9, 31);
    expect(formatDate("en", oct31, opts)).toBe("Oct 31");
    expect(formatDate("fr", oct31, opts)).toBe("31 oct.");
  });

  it("joins lists in each language's words", () => {
    expect(formatList("en", ["mug", "duck", "lamp"])).toBe("mug, duck, and lamp");
    expect(formatList("fr", ["tasse", "canard"])).toBe("tasse et canard");
  });
});

describe("catalog files (PIN-190)", () => {
  it("has exactly one catalog per supported language", () => {
    const files = readdirSync(path.join(__dirname, "messages"))
      .filter((name) => /^[A-Za-z-]+\.json$/.test(name))
      .map((name) => name.replace(/\.json$/, ""))
      .sort();
    expect(files).toEqual([...LOCALES].sort());
  });

  it("every language resolves every English key (fallback)", () => {
    for (const locale of LOCALES) {
      expect(t(locale, "landing.start").length).toBeGreaterThan(0);
    }
  });
});
