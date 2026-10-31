import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../i18n/messages/en.json";
import fr from "../../../i18n/messages/fr.json";
import { BillingBanner, MakesIndicator, MakesPoolEmpty, checkoutErrorLine } from "./MakesFlow";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const noop = () => {};

describe("creations indicator (PIN-152, PIN-182)", () => {
  it("renders nothing at all while the board view carries no credits", () => {
    expect(html(h(MakesIndicator, { credits: undefined, lowMakesWarning: 5, canBuy: true, onAddMakes: noop, locale: "en" }))).toBe("");
  });

  it("shows the count left, announced politely, with no low line while healthy", () => {
    const out = html(h(MakesIndicator, { credits: { availableMakes: 12 }, lowMakesWarning: 5, canBuy: false, onAddMakes: noop, locale: "en" }));
    expect(out).toContain("12 creations left");
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain('data-state="ok"');
    expect(out).not.toContain("Running low");
    // The way into the Plus sheet is hidden while billing is off.
    expect(out).not.toContain("Get Plus");
  });

  it("goes low at the Policy threshold and opens the Plus sheet from a Get Plus button", () => {
    const out = html(h(MakesIndicator, { credits: { availableMakes: 5 }, lowMakesWarning: 5, canBuy: true, onAddMakes: noop, locale: "en" }));
    expect(out).toContain('data-state="low"');
    expect(out).toContain("Running low");
    expect(out).toContain("Get Plus");
    const one = html(h(MakesIndicator, { credits: { availableMakes: 1 }, lowMakesWarning: 5, canBuy: true, onAddMakes: noop, locale: "en" }));
    expect(one).toContain("1 creation left");
  });

  it("at empty, says new scenes will be collages until someone adds more", () => {
    const out = html(h(MakesIndicator, { credits: { availableMakes: 0 }, lowMakesWarning: 5, canBuy: true, onAddMakes: noop, locale: "en" }));
    expect(out).toContain('data-state="empty"');
    expect(out).toContain("0 creations left");
    expect(out).toContain("New scenes will be collages");
  });

  it("renders the count in French", () => {
    const out = html(
      h(MakesIndicator, { credits: { availableMakes: 3 }, lowMakesWarning: 5, canBuy: true, onAddMakes: noop, locale: "fr" }),
    );
    expect(out).toContain("3 créations restantes");
    expect(out).toContain("Obtenir Plus");
  });
});

describe("billing return banner (PIN-152, PIN-182)", () => {
  const banner = (
    kind: Parameters<typeof BillingBanner>[0]["kind"],
    makes: number | null = 3,
    locale: "en" | "fr" = "en",
    plusActive = false,
  ) => html(h(BillingBanner, { kind, availableMakes: makes, plusActive, onDismiss: noop, locale }));

  it("announces processing without claiming success, and cannot be dismissed yet", () => {
    const out = banner("processing");
    expect(out).toContain("Adding your creations…");
    expect(out).toContain('aria-live="polite"');
    expect(out).not.toContain('aria-label="Close"');
  });

  it("confirms only the risen count, neutrally reports cancelled/failed/waiting", () => {
    expect(banner("added", 28)).toContain("Your creations are in — 28 creations left.");
    expect(banner("added", 28)).toContain('aria-label="Close"');
    expect(banner("cancelled")).toContain("No creations were added and nothing was charged.");
    expect(banner("failed")).toContain("That checkout didn&#x27;t finish.");
    expect(banner("checkLater")).toContain("Still waiting for your creations.");
    expect(banner("added", 28, "fr")).toContain("Vos créations sont arrivées — 28 créations restantes.");
  });

  it("adds that Plus is on only once the refetched view says so", () => {
    expect(banner("added", 20, "en", true)).toContain("Your creations are in — 20 creations left. Plus is on.");
    expect(banner("added", 20, "en", false)).not.toContain("Plus is on");
    expect(banner("added", 20, "fr", true)).toContain("Plus est activé.");
    // Only the success line mentions it.
    expect(banner("cancelled", 3, "en", true)).not.toContain("Plus is on");
  });
});

describe("pool-empty outcomes (PIN-152, PIN-182)", () => {
  it("give creation-aware copy and a way into the Plus sheet when buying works", () => {
    const photo = html(h(MakesPoolEmpty, { kind: "photo", canBuy: true, onAddMakes: noop, locale: "en" }));
    expect(photo).toContain("out of creations, so photos can&#x27;t be cut out");
    expect(photo).toContain('role="alert"');
    expect(photo).toContain("Get Plus");
    const scene = html(h(MakesPoolEmpty, { kind: "scene", canBuy: false, onAddMakes: noop, locale: "en" }));
    expect(scene).toContain("ran out of creations, so that scene couldn&#x27;t be made");
    expect(scene).not.toContain("Get Plus");
  });
});

describe("checkout error lines (moved onto the Plus sheet, PIN-182)", () => {
  it("words each failure on its own", () => {
    expect(checkoutErrorLine("cap")).toContain("Too many checkouts are already open");
    expect(checkoutErrorLine("rate")).toContain("Too many tries just now");
    expect(checkoutErrorLine("join")).toContain("Join this board first");
    expect(checkoutErrorLine("generic")).toContain("Couldn't open checkout. Try again.");
    expect(checkoutErrorLine("cap", "fr")).toContain("Trop de paiements");
  });
});

describe("makes flow wiring guards (PIN-152, PIN-182)", () => {
  const read = (name: string) => readFileSync(path.join(process.cwd(), "src/app/g/[slug]", name), "utf8");

  it("keeps the billing baseline hydration-safe: server count first, stored count after mount", () => {
    const source = read("MakesFlow.tsx");
    expect(source).toContain("useState<number | null>(initialAvailableMakes)");
    // sessionStorage is read only inside an effect, never while rendering.
    expect(source).not.toMatch(/useState[^;]*readBaseline/);
    expect(source).toMatch(/useEffect\(\(\) => \{\s*const stored = readBaseline\(slug, null\)/);
  });

  it("takes scene pool-empty from the scene POST job too, not only the disabled-on-terminal poll", () => {
    const source = read("BoardClient.tsx");
    expect(source).toContain("isPoolEmptyCode(data.job?.errorCode)");
    expect(source).toContain("scenePoolEmptyId === attempt.sceneId");
  });

  it("has one sheet that asks for money: the Plus sheet, mounted for everyone", () => {
    expect(read("MakesFlow.tsx")).not.toContain("MakesBuySheet");
    const board = read("BoardClient.tsx");
    expect(board).not.toContain("MakesBuySheet");
    expect(board).not.toMatch(/\{isHost \? \(\s*<PlusFlow/);
    expect(board).toMatch(/<PlusFlow\s[^>]*makes=\{makes\}/);
  });
});

describe("creations copy guardrails (PIN-152, PIN-182)", () => {
  /** Every string a person reads on the creations indicator and the Plus sheet. */
  const copyFamily = (key: string) => key.startsWith("makes.") || key.startsWith("ui.plus");
  const copyStrings = (catalog: Record<string, string>) =>
    Object.entries(catalog)
      .filter(([key]) => copyFamily(key))
      .map(([, value]) => value);

  it("keeps EN and FR keys in parity for every makes and Plus sheet string", () => {
    const enKeys = Object.keys(en).filter(copyFamily).sort();
    const frKeys = Object.keys(fr).filter(copyFamily).sort();
    expect(frKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(30);
    for (const value of copyStrings(fr)) expect(value.length).toBeGreaterThan(0);
  });

  it("never uses wallet / gift-card / cash / transfer / balance-as-money wording, and no dollars", () => {
    const banned = /\b(wallet|gift ?card|cash|transfer|balance|portefeuille|carte cadeau|espèces|transfert|solde)\b|\$/i;
    for (const value of [...copyStrings(en), ...copyStrings(fr)]) {
      expect(value).not.toMatch(banned);
    }
  });

  it("calls them creations in English: no make / makes left in a person's copy", () => {
    for (const value of copyStrings(en)) expect(value).not.toMatch(/\bmakes?\b/i);
    expect(en["makes.left.other"]).toBe("{n} creations left");
  });

  it("keeps the placeholders of each key the same in EN and FR", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [key, value] of Object.entries(fr)) {
      if (!copyFamily(key)) continue;
      expect(placeholders(value), key).toEqual(placeholders((en as Record<string, string>)[key]));
    }
  });
});
