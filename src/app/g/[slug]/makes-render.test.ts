import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { plusActionKey, poolEmptyCopy } from "../../../domain/makes-ui";
import { t } from "../../../i18n";
import en from "../../../i18n/messages/en.json";
import fr from "../../../i18n/messages/fr.json";
import { BillingBanner, MakesIndicator, checkoutErrorLine } from "./MakesFlow";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const noop = () => {};

describe("creations indicator (PIN-152, PIN-182, PIN-183)", () => {
  /** The shipped threshold: Policy.credits.lowMakesWarning is 2. */
  const indicator = (
    availableMakes: number | null,
    { locale = "en", ...over }: Partial<Parameters<typeof MakesIndicator>[0]> = {},
  ) =>
    html(
      h(MakesIndicator, {
        credits: availableMakes === null ? undefined : { availableMakes },
        lowMakesWarning: 2,
        plusActive: false,
        canBuy: true,
        onAddMakes: noop,
        locale,
        ...over,
      }),
    );

  it("renders nothing at all while the board view carries no credits", () => {
    expect(indicator(null)).toBe("");
  });

  it("renders nothing while there are more creations than the threshold, so the board looks like a credits-off board", () => {
    expect(indicator(12)).toBe("");
    expect(indicator(3)).toBe("");
    expect(indicator(3, { plusActive: true })).toBe("");
    // A threshold of 0 means no low state at all.
    expect(indicator(1, { lowMakesWarning: 0 })).toBe("");
  });

  it("goes low at the threshold: one quiet line with a Get Plus text button, no card", () => {
    const out = indicator(2);
    expect(out).toContain('data-state="low"');
    expect(out).toContain("2 creations left");
    expect(out).toContain("pn-board-meta");
    expect(out).toContain('aria-live="polite"');
    expect(out).toMatch(/<button[^>]*pn-btn-quiet[^>]*>Get Plus<\/button>/);
    // The separator is for the eye only.
    expect(out).toMatch(/aria-hidden="true">\s*·\s*</);
    expect(out).not.toContain("Running low");
    expect(indicator(1)).toContain("1 creation left");
  });

  it("says Add creations instead once the board has Plus", () => {
    const out = indicator(1, { plusActive: true });
    expect(out).toMatch(/<button[^>]*>Add creations<\/button>/);
    expect(out).not.toContain("Get Plus");
    expect(indicator(0, { plusActive: true })).toMatch(/<button[^>]*>Add creations<\/button>/);
  });

  it("at empty, says new scenes will be collages, with the same button", () => {
    const out = indicator(0);
    expect(out).toContain('data-state="empty"');
    expect(out).toContain("Out of creations. New scenes will be collages.");
    expect(out).not.toContain("0 creations left");
    expect(out).toMatch(/<button[^>]*>Get Plus<\/button>/);
    // Empty speaks even with the low state switched off.
    expect(indicator(0, { lowMakesWarning: 0 })).toContain("Out of creations.");
  });

  it("keeps the line and drops the button while billing is off", () => {
    expect(indicator(2, { canBuy: false })).toContain("2 creations left");
    expect(indicator(2, { canBuy: false })).not.toContain("<button");
    expect(indicator(0, { canBuy: false })).not.toContain("<button");
    expect(indicator(0, { canBuy: false })).toContain("Out of creations.");
  });

  it("renders in French", () => {
    expect(indicator(2, { locale: "fr" })).toContain("2 créations restantes");
    expect(indicator(2, { locale: "fr" })).toContain("Prendre Plus");
    expect(indicator(2, { locale: "fr", plusActive: true })).toContain("Ajouter des créations");
    expect(indicator(0, { locale: "fr" })).toContain("Plus de créations. Les nouvelles scènes seront des collages.");
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
    expect(banner("added", 28, "fr")).toContain("Tes créations sont arrivées — 28 créations restantes.");
  });

  it("adds that Plus is on only once the refetched view says so", () => {
    expect(banner("added", 20, "en", true)).toContain("Your creations are in — 20 creations left. Plus is on.");
    expect(banner("added", 20, "en", false)).not.toContain("Plus is on");
    expect(banner("added", 20, "fr", true)).toContain("Plus est activé.");
    // Only the success line mentions it.
    expect(banner("cancelled", 3, "en", true)).not.toContain("Plus is on");
  });
});

describe("pool-empty outcomes (PIN-152, PIN-182, PIN-183)", () => {
  const line = (kind: "photo" | "scene", flags: { canBuy: boolean; plusActive: boolean }, locale: "en" | "fr" = "en") =>
    t(locale, poolEmptyCopy(kind, flags).line);

  it("invite instead of failing when buying works: the same line for a photo and a scene", () => {
    const flags = { canBuy: true, plusActive: false };
    expect(line("photo", flags)).toBe("This board is out of creations. Get Plus to keep going.");
    expect(line("scene", flags)).toBe(line("photo", flags));
    expect(t("en", plusActionKey(false))).toBe("Get Plus");
    expect(line("photo", flags, "fr")).toBe("Ce tableau n'a plus de créations. Prends Plus pour continuer.");
  });

  it("ask for more instead of Plus once the board has it", () => {
    const flags = { canBuy: true, plusActive: true };
    expect(line("photo", flags)).toBe("This board is out of creations. Add more to keep going.");
    expect(t("en", plusActionKey(true))).toBe("Add creations");
    expect(line("scene", flags, "fr")).toBe("Ce tableau n'a plus de créations. Ajoutes-en pour continuer.");
  });

  it("keep the plain fact, and no button, when billing is off", () => {
    expect(line("photo", { canBuy: false, plusActive: false })).toContain("photos can't be cut out");
    expect(line("scene", { canBuy: false, plusActive: false })).toContain("that scene couldn't be made");
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

  it("opens the Plus sheet from the indicator, both pool-empty outcomes and the you menu (PIN-183)", () => {
    expect(read("AddSheet.tsx")).toContain('poolEmptyCopy("photo"');
    const board = read("BoardClient.tsx");
    expect(board).toContain('poolEmptyCopy("scene"');
    expect(board).toMatch(/action: poolEmpty\?\.action \? \{ label: t\(locale, poolEmpty\.action\), onSelect: openBuyMakes \}/);
    expect(board).toContain("onBoardPlus: openBuyMakes");
    expect(board).toMatch(/<MakesIndicator[^>]*plusActive=\{view\.plus\?\.active === true\}/);
  });

  it("lets a member who may change the look through, while try-on and Delete stay host-only (PIN-183)", () => {
    const board = read("BoardClient.tsx");
    expect(board).toMatch(/const canChangeLook = view\.viewer\?\.canChangeLook === true/);
    expect(board).toMatch(/useLookFlow\(\{[^}]*isHost,\s*canChangeLook,/);
    expect(board).toMatch(/isHost && deleteBoardOpen/);
  });

  it("dropped the old indicator card: no frame, count or note classes left", () => {
    const css = read("board.module.css");
    expect(css).not.toMatch(/\.makesCount|\.makesNote|\.makesPoolEmpty/);
    expect(css).not.toMatch(/\.makes\s*\{[^}]*border/);
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
