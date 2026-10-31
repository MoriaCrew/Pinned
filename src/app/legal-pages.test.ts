import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import en from "../i18n/messages/en.json";
import { DEFAULT_POLICY, resolvePolicy, type Policy } from "../policy/policy";

// Privacy + terms (PIN-26): the text follows this deploy's config and
// Policy, never literals, and never claims more than the code does.
const state = vi.hoisted(() => ({
  cfg: {} as Partial<AppConfig>,
  policy: null as Policy | null,
  locale: "en" as string,
}));

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), ...state.cfg }) };
});
vi.mock("../policy/server", () => ({ getPolicy: () => state.policy ?? DEFAULT_POLICY }));
vi.mock("../i18n/server", () => ({ getLocale: async () => state.locale }));

const { default: PrivacyPage, generateMetadata: privacyMetadata } = await import("./privacy/page");
const { default: TermsPage, generateMetadata: termsMetadata } = await import("./terms/page");
const { ISSUES_URL, SOURCE_URL } = await import("./_legal/LegalParts");

const privacy = async () => renderToStaticMarkup(await PrivacyPage());
const terms = async () => renderToStaticMarkup(await TermsPage());
/** Text only, so assertions read like the page (apostrophes unescaped). */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

beforeEach(() => {
  state.cfg = { authMode: "optional", plusMode: "stripe", legalContactEmail: null };
  state.policy = null;
  state.locale = "en";
});

describe("privacy page (PIN-26)", () => {
  it("has every section, names the four Meta models and the processors", async () => {
    const page = text(await privacy());
    for (const heading of [
      "Who runs Pinneds",
      "What we keep, and why",
      "AI processing",
      "Where your data lives",
      "Who can see what",
      "Cookies and browser storage",
      "Your controls",
      "People in photos",
      "Contact",
    ]) {
      expect(page).toContain(heading);
    }
    for (const model of ["Muse Spark", "SAM 3.1", "Muse Image", "Muse Voice"]) expect(page).toContain(model);
    expect(page).toContain("The photo you uploaded is never stored");
    expect(page).toContain("EXIF");
    expect(page).toContain("Standard mode, where Meta does not use this data to train its models");
    expect(page).toContain("We never store your email address");
    expect(page).toContain("Stripe");
    expect(page).toContain("no advertising or analytics cookies");
    expect(await privacy()).toContain(`href="${SOURCE_URL}"`);
  });

  it("takes every duration from Policy, none from a literal", async () => {
    state.policy = resolvePolicy({
      workingCopyTtlHours: 7,
      aiCallLogRetentionDays: 33,
      participantCookieDays: 11,
      userSessionDays: 12,
      localeCookieDays: 99,
      dictationMaxSeconds: 17,
      plus: { hostCookieDays: 222 },
    });
    const page = text(await privacy());
    for (const value of ["7 hours", "33 days", "11 days", "12 days", "99 days", "17 seconds", "222 days"]) {
      expect(page).toContain(value);
    }
    // The defaults (24 h, 90 / 30 / 365 days, 30 s) are not written anywhere.
    for (const value of ["24 hours", "90 days", "30 days", "365 days", "30 seconds"]) {
      expect(page).not.toContain(value);
    }
    state.policy = resolvePolicy({ workingCopyTtlHours: 1, aiCallLogRetentionDays: 1 });
    expect(text(await privacy())).toMatch(/after 1 hour and/);
    expect(text(await privacy())).toContain("deleted 1 day after the request");
  });

  it("never claims zero retention, and says store:false only when Policy sends it", async () => {
    for (const html of [await privacy(), await terms()]) {
      expect(html).not.toMatch(/zero[- ]?(data[- ])?retention/i);
      expect(html).not.toMatch(/Meta (never|does not|doesn't) (store|keep)/i);
    }
    // Defaults: scenes send store:false, SAM sends no flag (PIN-213).
    expect(text(await privacy())).toContain("When making a scene, we also ask Meta not to store the request.");
    state.policy = resolvePolicy({ samStore: false });
    expect(text(await privacy())).toContain("When cutting things out and making a scene, we also ask Meta");
    state.policy = resolvePolicy({ samStore: false, sceneStore: true });
    expect(text(await privacy())).toContain("When cutting things out, we also ask Meta");
    state.policy = resolvePolicy({ sceneStore: true });
    expect(text(await privacy())).not.toContain("ask Meta not to store");
  });

  it("shows sign-in and payment lines only where this deploy has them", async () => {
    state.cfg = { ...state.cfg, authMode: "link-only", plusMode: "off" };
    const page = text(await privacy());
    expect(page).not.toContain("pinned_user");
    expect(page).not.toContain("Google sign-in");
    expect(page).not.toContain("card number");
    expect(page).toContain("pinned_player_");
  });

  it("names the face reminder only when Policy shows it", async () => {
    expect(text(await privacy())).toContain("the app reminds you to pin it only if the people in it are happy");
    state.policy = resolvePolicy({ faces: "allow" });
    expect(text(await privacy())).not.toContain("reminds you");
  });
});

describe("contact (PIN-26)", () => {
  it("falls back to a public GitHub issue when LEGAL_CONTACT_EMAIL is unset", async () => {
    for (const html of [await privacy(), await terms()]) {
      expect(html).toContain(`href="${ISSUES_URL}"`);
      expect(html).not.toContain("mailto:");
      expect(text(html)).toContain("Issues are public");
    }
  });

  it("shows the configured address, and only that", async () => {
    state.cfg = { ...state.cfg, legalContactEmail: "hello@example.org" };
    for (const html of [await privacy(), await terms()]) {
      expect(html).toContain('href="mailto:hello@example.org"');
      expect(html).not.toContain(`href="${ISSUES_URL}"`);
      expect(html.match(/mailto:/g)).toHaveLength(1);
    }
  });
});

describe("terms page (PIN-26)", () => {
  it("has every section", async () => {
    const page = text(await terms());
    for (const heading of [
      "About these terms",
      "Using Pinneds",
      "Your content",
      "Board Plus",
      "No warranty",
      "Open source",
      "Changes",
      "Governing law",
      "Contact",
    ]) {
      expect(page).toContain(heading);
    }
    expect(page).toContain("You keep the rights to what you upload");
    expect(page).toContain("hides the scenes that used it");
    expect(page).toContain("GNU AGPL-3.0");
  });

  it("prices Board Plus from the Policy pack with the app's money format", async () => {
    expect(text(await terms())).toContain("€2.99 for Board Plus and 20 creations");
    state.policy = resolvePolicy({
      credits: { packs: [{ lookupKey: "pinneds_plus_20", credits: 7, eurCents: 450, label: "unused" }] },
    });
    const page = text(await terms());
    expect(page).toContain("€4.50 for Board Plus and 7 creations");
    expect(page).not.toContain("€2.99");
    expect(page).not.toContain("unused");
  });

  it("says how refunds and disputes work, as shipped (creations taken back)", async () => {
    const page = text(await terms());
    expect(page).toContain("to ask for one, contact us with the date and amount of the payment");
    expect(await terms()).toContain('<a href="#contact">contact us</a>');
    expect(page).toContain("the creations it added are taken off the board in proportion to the refund");
    expect(page).toContain("those creations are on hold until the dispute ends");
  });

  it("follows PLUS_MODE: not on sale when off, a demo note when mock", async () => {
    expect(text(await terms())).not.toContain("not on sale");
    state.cfg = { ...state.cfg, plusMode: "off" };
    expect(text(await terms())).toContain("Board Plus is not on sale on this site right now");
    state.cfg = { ...state.cfg, plusMode: "mock" };
    expect(text(await terms())).toContain("demo checkout: nothing is charged");
  });
});

describe("legal page chrome (PIN-26)", () => {
  it("titles come from the catalog", async () => {
    expect((await privacyMetadata()).title).toBe(`${en["legal.privacyTitle"]} — Pinneds`);
    expect((await termsMetadata()).title).toBe(`${en["legal.termsTitle"]} — Pinneds`);
  });

  it("marks the body English and adds the English-only note in other languages", async () => {
    expect(await privacy()).not.toContain(en["legal.englishOnly"]);
    state.locale = "fr";
    for (const html of [await privacy(), await terms()]) {
      expect(html).toContain('class="pn-legal-body" lang="en"');
      expect(html).toContain('class="pn-legal-note"');
    }
  });

  it("links both pages and the source from the footer, current page marked", async () => {
    const html = await privacy();
    expect(html).toContain('href="/privacy" aria-current="page"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain(`>${en["footer.source"]}</a>`);
    expect(await terms()).toContain('href="/terms" aria-current="page"');
  });
});
