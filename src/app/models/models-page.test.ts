import { existsSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALES, t, tf } from "../../i18n";
import en from "../../i18n/messages/en.json";
import { DEFAULT_POLICY, type Policy } from "../../policy/policy";

// /models (PIN-237): the visitor's version of docs/19, reached from the landing.
const state = vi.hoisted(() => ({ locale: "en" as string, policy: null as Policy | null }));
vi.mock("../../i18n/server", () => ({ getLocale: async () => state.locale }));
vi.mock("../../policy/server", () => ({ getPolicy: () => state.policy ?? DEFAULT_POLICY }));

const { default: ModelsPage, generateMetadata } = await import("./page");
const { EXAMPLE, MODEL_NAMES, MODELS_DOC_URL } = await import("./models.data");
const { landingSetById } = await import("../landing-sets.data");

const page = async () => renderToStaticMarkup(await ModelsPage());
/** Text only, apostrophes unescaped, so assertions read like the page. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

beforeEach(() => {
  state.locale = "en";
  state.policy = null;
});

describe("models page (PIN-237)", () => {
  it("titles the page like the other public pages", async () => {
    const meta = await generateMetadata();
    expect(meta.title).toBe(`${en["models.pageTitle"]} — Pinneds`);
    expect(meta.description).toBe(en["models.lead"]);
    expect(text(await page())).toContain(en["models.pageTitle"]);
  });

  it("walks through the Meta-made cat set only, every picture from that set's folder", async () => {
    expect(EXAMPLE.setId).toBe("cat");
    const html = await page();
    const files = [...html.matchAll(/src="([^"]+)"/g)].map((match) => match[1] as string);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.startsWith("/landing/sets/cat/"), file).toBe(true);
      expect(existsSync(path.join(process.cwd(), "public", file)), file).toBe(true);
    }
    expect(files).toContain(EXAMPLE.photo.src);
    expect(files).toContain(EXAMPLE.scene);
  });

  it("keeps the example's owners true to the set: the photo's things are its owner's", () => {
    const set = landingSetById("cat");
    for (const thing of EXAMPLE.things) expect(thing.owner.name).toBe(EXAMPLE.photo.owner);
    for (const pick of EXAMPLE.picks) expect(pick.owner.name).toBe(set.stickers[pick.sticker]?.owner);
  });

  it("starts on step one: one visible layer and text, the rest hidden, Back unavailable", async () => {
    const html = await page();
    expect(html.match(/data-active=""/g)).toHaveLength(2);
    expect(html).toContain(`aria-current="step" aria-label="${tf("en", "models.goToStep", { n: 1, title: en["models.step1.title"] }).replace(/'/g, "&#x27;")}"`);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>.*?Back<\/button>/s);
    expect(html).toContain('aria-live="polite"');
    for (const key of ["models.step1.title", "models.step2.title", "models.step3.title", "models.step4.title"] as const) {
      expect(text(html)).toContain(en[key]);
    }
    expect(text(html)).toContain(tf("en", "models.stepOf", { n: 1, total: 4 }));
  });

  it("gives the pictures alt text from the catalog and credits every pick", async () => {
    const markup = await page();
    const html = text(markup);
    expect(markup).toContain(`alt="${tf("en", "models.photoAlt", { owner: EXAMPLE.photo.owner }).replace(/'/g, "&#x27;")}"`);
    expect(markup).toContain(`alt="${en["models.sceneAlt"]}"`);
    for (const pick of EXAMPLE.picks) {
      expect(html).toContain(t("en", pick.label));
      expect(html).toContain(pick.owner.name);
    }
  });

  it("has one card per model, each saying what it sees and never sees", async () => {
    const html = await page();
    const cards = [...html.slice(html.indexOf('id="models-cards"')).matchAll(/<h3 class="[^"]*">([^<]+)<\/h3>/g)].map((match) => match[1]);
    expect(cards).toEqual(Object.values(MODEL_NAMES));
    expect(html.match(new RegExp(`<dt>${en["models.sees"]}</dt>`, "g"))).toHaveLength(5);
    expect(html.match(new RegExp(`<dt>${en["models.neverSees"]}</dt>`, "g"))).toHaveLength(5);
    const page_ = text(html);
    expect(page_).toContain(tf("en", "models.open.does", { n: LOCALES.length - 1 }));
    expect(page_).toContain(tf("en", "models.builtBody", { n: LOCALES.length - 1 }));
  });

  it("never claims zero data retention, and names store: false only while Policy sends it", async () => {
    const on = text(await page());
    expect(on).toContain(en["models.standardMode"]);
    expect(on).toContain(en["models.noStore"]);
    // The only mention of zero data retention is the disclaimer.
    expect(on.match(/zero data retention/gi)).toHaveLength(1);
    expect(on).toMatch(/don't claim zero data retention/);
    state.policy = { ...DEFAULT_POLICY, sceneStore: true };
    expect(text(await page())).not.toContain("store: false");
  });

  it("links the developer doc, Start a board, and the site links", async () => {
    const html = await page();
    expect(MODELS_DOC_URL).toBe("https://github.com/MoriaCrew/Pinned/blob/main/docs/19-meta-models.md");
    expect(html).toContain(`<a href="${MODELS_DOC_URL}">${en["models.technical"]}</a>`);
    expect(html).toMatch(new RegExp(`<a [^>]*href="/new"[^>]*>.*?${en["landing.start"]}</a>`, "s"));
    expect(html).toContain(`<a href="/privacy">${en["footer.privacy"]}</a>`);
  });

  it("follows the visitor's language, model names unchanged", async () => {
    state.locale = "fr";
    const html = text(await page());
    expect(html).toContain(t("fr", "models.pageTitle"));
    expect(html).toContain(t("fr", "landing.start"));
    for (const name of Object.values(MODEL_NAMES)) expect(html).toContain(name);
  });
});
