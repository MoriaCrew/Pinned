import { describe, expect, it } from "vitest";
import {
  LOCALE_NAMES,
  LOCALES,
  matchLocale,
  negotiateLocale,
  parseAcceptLanguage,
  parseLocaleList,
  type Locale,
} from "./locales";

const ALL: readonly Locale[] = LOCALES;

describe("parseLocaleList (UI_LOCALES)", () => {
  it("defaults to English only", () => {
    expect(parseLocaleList(undefined)).toEqual(["en"]);
    expect(parseLocaleList("")).toEqual(["en"]);
  });

  it("keeps known codes in LOCALES order, English always first", () => {
    expect(parseLocaleList("id, fr ,pt-br,de")).toEqual(["en", "fr", "pt-BR", "de", "id"]);
  });

  it("drops unknown codes and duplicates", () => {
    expect(parseLocaleList("fr,ja,fr,xx,,")).toEqual(["en", "fr"]);
  });
});

describe("parseAcceptLanguage", () => {
  it("orders by q, keeping header order on ties", () => {
    expect(parseAcceptLanguage("de;q=0.5, fr-CH, fr;q=0.9, en;q=0.9")).toEqual([
      "fr-CH",
      "fr",
      "en",
      "de",
    ]);
  });

  it("skips q=0, bad q values and malformed tags", () => {
    expect(parseAcceptLanguage("fr;q=0, es;q=abc, de;q=2, <script>, it")).toEqual(["it"]);
  });

  it("handles empty and missing headers", () => {
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
  });
});

describe("matchLocale", () => {
  it.each([
    ["en-US", "en"],
    ["fr-CA", "fr"],
    ["pt-PT", "pt-BR"],
    ["PT-br", "pt-BR"],
    ["es-419", "es"],
    ["id-ID", "id"],
    ["in-ID", "id"],
    ["de-AT", "de"],
    ["it", "it"],
  ])("%s → %s", (tag, expected) => {
    expect(matchLocale(tag, ALL)).toBe(expected);
  });

  it.each(["ja", "zh-CN", "*", "pt-x"])("%s → no match", (tag) => {
    expect(matchLocale(tag, ["en", "fr"])).toBeNull();
  });
});

describe("negotiateLocale", () => {
  it("uses the saved choice when that language is on", () => {
    expect(negotiateLocale({ cookie: "es", acceptLanguage: "fr", enabled: ALL })).toBe("es");
  });

  it("ignores a saved choice that is off or unknown", () => {
    expect(negotiateLocale({ cookie: "es", acceptLanguage: "fr", enabled: ["en", "fr"] })).toBe("fr");
    expect(negotiateLocale({ cookie: "xx", acceptLanguage: "de", enabled: ALL })).toBe("de");
  });

  it("takes the best Accept-Language match", () => {
    expect(
      negotiateLocale({ acceptLanguage: "ja, pt-PT;q=0.8, en;q=0.5", enabled: ALL }),
    ).toBe("pt-BR");
  });

  it("keeps English for an English-first browser", () => {
    expect(negotiateLocale({ acceptLanguage: "en-US,en;q=0.9,fr;q=0.8", enabled: ALL })).toBe("en");
  });

  it("falls back to English", () => {
    expect(negotiateLocale({ acceptLanguage: "ja, zh;q=0.9", enabled: ALL })).toBe("en");
    expect(negotiateLocale({ acceptLanguage: "*", enabled: ALL })).toBe("en");
    expect(negotiateLocale({ acceptLanguage: "garbage;;;", enabled: ALL })).toBe("en");
    expect(negotiateLocale({ enabled: ALL })).toBe("en");
  });

  it("stays English when only English is on (the default)", () => {
    expect(negotiateLocale({ cookie: "fr", acceptLanguage: "fr-FR", enabled: ["en"] })).toBe("en");
  });
});

describe("LOCALE_NAMES", () => {
  it("names every language in its own words", () => {
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual([...LOCALES].sort());
    expect(LOCALE_NAMES.fr).toBe("Français");
  });
});
