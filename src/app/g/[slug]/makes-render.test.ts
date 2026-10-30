import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MakesPack } from "../../../domain/makes-ui";
import en from "../../../i18n/messages/en.json";
import fr from "../../../i18n/messages/fr.json";
import { BillingBanner, MakesBuySheet, MakesIndicator, MakesPoolEmpty } from "./MakesFlow";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const noop = () => {};

const packs: MakesPack[] = [
  { lookupKey: "pinneds_credits_25", credits: 25, eurCents: 499, label: "25 makes · €4.99" },
  { lookupKey: "pinneds_credits_60", credits: 60, eurCents: 999, label: "60 makes · €9.99" },
  { lookupKey: "pinneds_credits_150", credits: 150, eurCents: 1999, label: "150 makes · €19.99" },
];

describe("makes indicator (PIN-152)", () => {
  it("renders nothing at all while the board view carries no credits", () => {
    expect(html(h(MakesIndicator, { credits: undefined, lowMakesWarning: 5, canBuy: true, onAddMakes: noop }))).toBe("");
  });

  it("shows the count left, announced politely, with no low line while healthy", () => {
    const out = html(h(MakesIndicator, { credits: { availableMakes: 12 }, lowMakesWarning: 5, canBuy: false, onAddMakes: noop }));
    expect(out).toContain("12 makes left");
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain('data-state="ok"');
    expect(out).not.toContain("Running low");
    // Buying hidden while it cannot work (off/mock).
    expect(out).not.toContain("Add makes");
  });

  it("goes low at the Policy threshold and offers the buy sheet in stripe mode", () => {
    const out = html(h(MakesIndicator, { credits: { availableMakes: 5 }, lowMakesWarning: 5, canBuy: true, onAddMakes: noop }));
    expect(out).toContain('data-state="low"');
    expect(out).toContain("Running low");
    expect(out).toContain("Add makes");
    const one = html(h(MakesIndicator, { credits: { availableMakes: 1 }, lowMakesWarning: 5, canBuy: true, onAddMakes: noop }));
    expect(one).toContain("1 make left");
  });

  it("at empty, says new scenes will be collages until someone adds more", () => {
    const out = html(h(MakesIndicator, { credits: { availableMakes: 0 }, lowMakesWarning: 5, canBuy: true, onAddMakes: noop }));
    expect(out).toContain('data-state="empty"');
    expect(out).toContain("0 makes left");
    expect(out).toContain("New scenes will be collages");
  });

  it("renders the count in French", () => {
    const out = html(
      h(MakesIndicator, { credits: { availableMakes: 3 }, lowMakesWarning: 5, canBuy: true, onAddMakes: noop, locale: "fr" }),
    );
    expect(out).toContain("3 créations restantes");
    expect(out).toContain("Ajouter des créations");
  });
});

describe("makes buy sheet (PIN-152)", () => {
  const sheet = (over: Partial<Parameters<typeof MakesBuySheet>[0]> = {}) =>
    html(h(MakesBuySheet, { packs, canBuy: true, onBuy: noop, onClose: noop, ...over }));

  it("lists the Policy packs as radios with EUR tax-included prices and per-make lines", () => {
    const out = sheet();
    expect(out.match(/type="radio"/g)).toHaveLength(3);
    expect(out).toMatch(/checked="" value="pinneds_credits_25"/);
    expect(out).toContain("25 makes");
    expect(out).toContain("€4.99 incl. tax");
    expect(out).toContain("€19.99 incl. tax");
    expect(out).toContain("About €0.20 per make");
    expect(out).toContain("Anyone on this board can add makes");
    expect(out).toContain("You may be charged in your local currency.");
    expect(out).toContain("Appears as PINNEDS on your statement.");
    expect(out).toContain("Add 25 makes · €4.99");
    expect(out).toContain('role="dialog"');
  });

  it("renders a different Policy offer without a code change", () => {
    const out = sheet({ packs: [{ lookupKey: "pack_x", credits: 7, eurCents: 350, label: "x" }] });
    expect(out).toContain("7 makes");
    expect(out).toContain("€3.50 incl. tax");
    expect(out).not.toContain("25 makes");
  });

  it("sells nothing with buying off, and says so", () => {
    const out = sheet({ canBuy: false });
    expect(out).toContain("Adding makes isn&#x27;t open yet. Nothing is charged.");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?Add 25 makes/);
    const unavailable = sheet({ unavailable: true });
    expect(unavailable).toContain("isn&#x27;t open yet");
    expect(unavailable).toMatch(/<button[^>]*disabled=""/);
  });

  it("shows in-flight and checkout error states inline", () => {
    expect(sheet({ busy: true })).toContain("Opening checkout…");
    expect(sheet({ busy: true })).toMatch(/<button[^>]*disabled=""[^>]*>Opening checkout/);
    const cap = sheet({ error: "cap" });
    expect(cap).toContain('role="alert"');
    expect(cap).toContain("Too many checkouts are already open");
    expect(sheet({ error: "rate" })).toContain("Too many tries just now");
    expect(sheet({ error: "generic" })).toContain("Couldn&#x27;t open checkout. Try again.");
  });

  it("never shares a pack radio name between two sheets", () => {
    const out = html(h("div", null, h(MakesBuySheet, { packs, canBuy: true, onBuy: noop, onClose: noop }), h(MakesBuySheet, { packs, canBuy: true, onBuy: noop, onClose: noop })));
    const names = [...new Set([...out.matchAll(/type="radio" name="([^"]+)"/g)].map((m) => m[1]))];
    expect(names).toHaveLength(2);
  });

  it("renders the sheet in French with French prices", () => {
    const out = sheet({ locale: "fr" });
    expect(out).toContain("Ajouter des créations");
    expect(out).toContain("25 créations");
    expect(out).toContain("4,99 € TTC");
    expect(out).toContain("Environ 0,20 € par création");
    expect(out).toContain("Apparaît sous le nom PINNEDS");
    expect(out).toContain("Ajouter 25 créations · 4,99 €");
  });
});

describe("billing return banner (PIN-152)", () => {
  const banner = (kind: Parameters<typeof BillingBanner>[0]["kind"], makes: number | null = 3, locale: "en" | "fr" = "en") =>
    html(h(BillingBanner, { kind, availableMakes: makes, onDismiss: noop, locale }));

  it("announces processing without claiming success, and cannot be dismissed yet", () => {
    const out = banner("processing");
    expect(out).toContain("Adding your makes…");
    expect(out).toContain('aria-live="polite"');
    expect(out).not.toContain('aria-label="Close"');
  });

  it("confirms only the risen count, neutrally reports cancelled/failed/waiting", () => {
    expect(banner("added", 28)).toContain("Your makes are in — 28 makes left.");
    expect(banner("added", 28)).toContain('aria-label="Close"');
    expect(banner("cancelled")).toContain("No makes were added and nothing was charged.");
    expect(banner("failed")).toContain("That checkout didn&#x27;t finish.");
    expect(banner("checkLater")).toContain("Still waiting for your makes.");
    expect(banner("added", 28, "fr")).toContain("Vos créations sont arrivées — 28 créations restantes.");
  });
});

describe("pool-empty outcomes (PIN-152)", () => {
  it("give make-aware copy and a way into the buy sheet when buying works", () => {
    const photo = html(h(MakesPoolEmpty, { kind: "photo", canBuy: true, onAddMakes: noop }));
    expect(photo).toContain("out of makes, so photos can&#x27;t be cut out");
    expect(photo).toContain('role="alert"');
    expect(photo).toContain("Add makes");
    const scene = html(h(MakesPoolEmpty, { kind: "scene", canBuy: false, onAddMakes: noop }));
    expect(scene).toContain("ran out of makes, so that scene couldn&#x27;t be made");
    expect(scene).not.toContain("Add makes");
  });
});

describe("makes flow wiring guards (PIN-152)", () => {
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
});

describe("makes copy guardrails (PIN-152)", () => {
  const makesStrings = (catalog: Record<string, string>) =>
    Object.entries(catalog)
      .filter(([key]) => key.startsWith("makes."))
      .map(([, value]) => value);

  it("keeps EN and FR keys in parity for every makes string", () => {
    const enKeys = Object.keys(en).filter((key) => key.startsWith("makes.")).sort();
    const frKeys = Object.keys(fr).filter((key) => key.startsWith("makes.")).sort();
    expect(frKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(20);
    for (const value of makesStrings(fr)) expect(value.length).toBeGreaterThan(0);
  });

  it("never uses wallet / gift-card / cash / transfer / balance-as-money wording, and no dollars", () => {
    const banned = /\b(wallet|gift ?card|cash|transfer|balance|portefeuille|carte cadeau|espèces|transfert|solde)\b|\$/i;
    for (const value of [...makesStrings(en), ...makesStrings(fr)]) {
      expect(value).not.toMatch(banned);
    }
  });
});
