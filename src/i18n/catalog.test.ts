import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listLocales, runCatalogCheck } from "../../scripts/i18n/catalog.mjs";
import {
  batchKeys,
  checkCatalog,
  checkEntry,
  deltaKeys,
  entryHash,
  findUnusedKeys,
  orderLikeEnglish,
  parseModelJson,
  ReviewSchema,
  validateBatch,
} from "../../scripts/i18n/core.mjs";

const P = "translate-ui.v1";

describe("i18n catalogs (PIN-189 offline check)", () => {
  it("every locale file passes: known keys, same placeholders, full plural pairs", () => {
    const report = runCatalogCheck();
    for (const [locale, { errors }] of Object.entries(report.locales)) {
      expect(errors, locale).toEqual([]);
    }
  });

  it("discovers locales from files, skipping en.json and lock files, and accepts empty ones", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "i18n-"));
    writeFileSync(path.join(dir, "en.json"), JSON.stringify({ "a.b": "Hi {name}" }));
    writeFileSync(path.join(dir, "es.json"), "{}");
    writeFileSync(path.join(dir, "es.lock.json"), JSON.stringify({ keys: {} }));
    writeFileSync(path.join(dir, "pt-BR.json"), JSON.stringify({ "a.b": "Oi {name}" }));
    expect(listLocales(dir)).toEqual(["es", "pt-BR"]);
    const report = runCatalogCheck({ dir });
    expect(report.locales.es).toEqual({ errors: [], missing: ["a.b"] });
    expect(report.locales["pt-BR"]).toEqual({ errors: [], missing: [] });
  });
});

describe("checkCatalog", () => {
  const en = { "x.one": "{n} pin", "x.other": "{n} pins", "y": "Hello {name}" };

  it("reports missing translations without failing", () => {
    expect(checkCatalog(en, {})).toEqual({ errors: [], missing: ["x.one", "x.other", "y"] });
  });

  it("flags unknown keys, placeholder drift and half plural pairs", () => {
    const { errors } = checkCatalog(en, { "x.one": "{n} épingle", y: "Salut {nom}", stale: "?" });
    expect(errors).toEqual([
      "x.one: plural pair missing x.other",
      "y: placeholders {nom} ≠ English {name}",
      "stale: not in en.json",
    ]);
  });
});

describe("delta detection", () => {
  const en = { a: "One", b: "Two", c: "Three" };

  it("translates keys that are missing, unlocked, or whose English changed", () => {
    const locale = { a: "Uno", b: "Due", c: "Tre" };
    const lock = { keys: { a: entryHash("One", P), b: entryHash("Old two", P) } };
    expect(deltaKeys({ en, locale, lock, promptVersion: P })).toEqual(["b", "c"]);
  });

  it("re-translates everything when the prompt version changes", () => {
    const locale = { a: "Uno" };
    const lock = { keys: { a: entryHash("One", P) } };
    expect(deltaKeys({ en, locale, lock, promptVersion: "translate-ui.v2" })).toEqual(["a", "b", "c"]);
  });

  it("honours --keys and --force", () => {
    const locale = { a: "Uno", b: "Due" };
    const lock = { keys: { a: entryHash("One", P), b: entryHash("Two", P) } };
    expect(deltaKeys({ en, locale, lock, promptVersion: P, only: ["a", "c"] })).toEqual(["c"]);
    expect(deltaKeys({ en, locale, lock, promptVersion: P, only: ["a"], force: true })).toEqual(["a"]);
  });

  it("never splits a plural pair across batches", () => {
    expect(batchKeys(["a", "b.one", "b.other", "c"], 2)).toEqual([["a", "b.one", "b.other"], ["c"]]);
  });

  it("writes catalogs in English key order", () => {
    expect(Object.keys(orderLikeEnglish(en, { c: "Tre", a: "Uno", zz: "x" }))).toEqual(["a", "c"]);
  });
});

describe("tolerant JSON parse", () => {
  it("accepts fenced JSON", () => {
    expect(parseModelJson('```json\n{"a":"Ciao"}\n```')).toEqual({ a: "Ciao" });
  });

  it("extracts the outermost object from prose, braces in strings included", () => {
    expect(parseModelJson('Sure! Here it is: {"a":"x {n} }","b":"y"} Hope it helps.')).toEqual({
      a: "x {n} }",
      b: "y",
    });
  });

  it("rejects truncated, empty and wrongly shaped replies", () => {
    expect(() => parseModelJson('{"a":"Ciao","b":"Gra')).toThrow("truncated");
    expect(() => parseModelJson("")).toThrow("empty");
    expect(() => parseModelJson("no json here")).toThrow("no JSON");
    expect(() => parseModelJson('{"a":1}')).toThrow("unexpected JSON shape");
  });

  it("parses reviewer corrections", () => {
    const r = parseModelJson('{"corrections":[{"key":"a","value":"b","reason":"c"}]}', ReviewSchema);
    expect(r.corrections).toHaveLength(1);
  });
});

describe("deterministic checks on model results", () => {
  const dnt = { doNotTranslate: ["Pinneds", "Stripe"] };

  it("requires identical placeholder sets and do-not-translate terms", () => {
    expect(checkEntry("{n} of {max}", "{n} su {max}", dnt).errors).toEqual([]);
    expect(checkEntry("{n} of {max}", "{n} su {massimo}", dnt).errors[0]).toMatch(/placeholders/);
    expect(checkEntry("Pay with Stripe", "Paga con Strip", dnt).errors[0]).toMatch(/Stripe/);
    expect(checkEntry("Hi", " ", dnt).errors).toEqual(["empty value"]);
  });

  it("warns (does not fail) on long or emoji-added strings", () => {
    const r = checkEntry("Start a board", "Inizia a creare una nuova bacheca condivisa 🎉");
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/long/);
    expect(r.warnings.join(" ")).toMatch(/emoji/);
  });

  it("validates a batch: missing keys, plural pairs all-or-nothing, U+202F → space", () => {
    const requested = { "n.one": "{n} pin", "n.other": "{n} pins", q: "Ready?" };
    const r = validateBatch(requested, { "n.one": "{n} épingle", "n.other": "{x} épingles", q: "Prêt ?", extra: "x" });
    expect(r.ok).toEqual({ q: "Prêt ?" });
    expect(Object.keys(r.failed).sort()).toEqual(["n.one", "n.other"]);
    expect(r.extra).toEqual(["extra"]);
    expect(validateBatch({ a: "A" }, {}).failed).toEqual({ a: "missing from reply" });
  });
});

describe("unused key scan", () => {
  it("counts quoted keys, tCount bases and template families as used", () => {
    const sources = [
      { path: "src/a.tsx", text: 't("en", "landing.start"); tCount(l, "meta.people", n); `skin.${id}.mood`' },
      { path: "src/b.ts", text: "t(l, `create.reason.${r}` as MessageKey)" },
      { path: "src/c.test.ts", text: '"only.inTest"' },
    ];
    const keys = [
      "landing.start",
      "meta.people.one",
      "meta.people.other",
      "skin.disco.mood",
      "skin.disco",
      "create.reason.party",
      "only.inTest",
      "game.challenge",
    ];
    expect(findUnusedKeys(keys, sources)).toEqual({ unused: ["skin.disco", "game.challenge"], testOnly: ["only.inTest"] });
  });
});
