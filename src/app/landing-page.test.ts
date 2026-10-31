import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../i18n/messages/en.json";
import { LANDING_SETS, landingSetById } from "./landing-sets.data";
import HomePage from "./page";

// The landing renders one showcase set per request (PIN-175).

type Query = { [key: string]: string | string[] | undefined };
async function landing(query: Query = {}): Promise<string> {
  return renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve(query) }));
}

const files = (html: string) => [...html.matchAll(/src="(\/landing\/[^"]+)"/g)].map((match) => match[1] as string);

afterEach(() => vi.restoreAllMocks());

describe("landing page showcase sets (PIN-175)", () => {
  it("draws only the pictures of the requested set", async () => {
    for (const set of LANDING_SETS) {
      const shown = files(await landing({ set: set.id }));
      expect(shown.length).toBeGreaterThan(0);
      for (const file of shown) expect(file.startsWith(`/landing/sets/${set.id}/`), file).toBe(true);
      // The pile (6 or so) and the three steps: every set picture is on the page.
      expect(shown).toContain(set.photo.src);
      expect(shown).toContain(set.scene.src);
    }
  });

  it("picks a set at random when none is asked for, or the ask is unknown or repeated", async () => {
    for (const query of [{}, { set: "nope" }, { set: ["classic", "cat"] }, { set: "" }]) {
      vi.spyOn(Math, "random").mockReturnValue(0);
      expect(await landing(query)).toContain(`/landing/sets/${LANDING_SETS[0]?.id}/`);
      vi.spyOn(Math, "random").mockReturnValue(0.999);
      expect(await landing(query)).toContain(`/landing/sets/${LANDING_SETS[LANDING_SETS.length - 1]?.id}/`);
    }
  });

  it("links to a different set with a plain, labelled anchor", async () => {
    for (const set of LANDING_SETS) {
      const html = await landing({ set: set.id });
      const link = /<a [^>]*class="[^"]*pn-landing-another[^"]*"[^>]*>/.exec(html)?.[0] ?? "";
      const href = /href="\/\?set=([a-z0-9-]+)"/.exec(link)?.[1];
      expect(href, set.id).toBeDefined();
      expect(href).not.toBe(set.id);
      expect(LANDING_SETS.map((entry) => entry.id)).toContain(href);
      expect(link).toContain(`aria-label="${en["landing.anotherLabel"]}"`);
      expect(html).toContain(en["landing.another"]);
    }
  });

  it("places the photo's chips from the set's anchors", async () => {
    for (const set of LANDING_SETS) {
      const html = await landing({ set: set.id });
      for (const chip of set.photo.chips) {
        expect(html).toContain(`style="left:${chip.left}%;top:${chip.top}%;rotate:${chip.rotate ?? 0}deg"`);
        expect(html).toContain(en[chip.label]);
      }
    }
  });

  it("keeps the art decorative: hidden from assistive tech, empty alt", async () => {
    const html = await landing({ set: "classic" });
    expect(html).toContain('class="pn-landing-pile" aria-hidden="true"');
    expect((html.match(/<img /g) ?? []).length).toBe((html.match(/<img [^>]*alt=""/g) ?? []).length);
  });

  it("lifts the link above the pile: its stickers are positioned and spill past the box", () => {
    const css = readFileSync(path.join(process.cwd(), "src/ui/pinneds.css"), "utf8");
    expect(css).toMatch(/\.pn-landing-another \{[^}]*position: relative;[^}]*z-index: 1;/);
    expect(css).toMatch(/\.pn-landing-pile \{[^}]*position: relative;/);
  });

  it("loads the hero stickers at once and the pictures further down when needed", async () => {
    const set = landingSetById("classic");
    const html = await landing({ set: set.id });
    const tag = (src: string) => new RegExp(`<img [^>]*src="${src}"[^>]*>`).exec(html)?.[0] ?? "";
    const pile = set.stickers[set.pile[0]?.sticker ?? ""]?.src ?? "";
    expect(tag(pile)).toContain('loading="eager"');
    expect(tag(set.photo.src)).toContain('loading="lazy"');
    expect(tag(set.scene.src)).toContain('loading="lazy"');
  });
});

describe("landing Made with Meta AI credit (PIN-222)", () => {
  it("names the four models, one short line each, in the footer", async () => {
    const html = await landing({ set: "classic" });
    const footer = /<footer class="pn-landing-foot">.*<\/footer>/s.exec(html)?.[0] ?? "";
    expect(footer).toContain(`id="made-with-meta">${en["landing.meta.title"]}</h2>`);
    const lines = [...footer.matchAll(/<li><svg[^>]*>.*?<\/svg>([^<]+)<\/li>/gs)].map((match) => match[1]);
    expect(lines).toEqual([
      en["landing.meta.spark"],
      en["landing.meta.sam"],
      en["landing.meta.image"],
      en["landing.meta.voice"],
    ]);
    // A credit, not an ad: every line stays short, and the icons are decoration.
    for (const line of lines) expect(line?.split(" ").length).toBeLessThanOrEqual(6);
    expect(footer).not.toMatch(/<svg[^>]*role="img"/);
  });

  it("keeps the model names as product names and links the models doc and the source", async () => {
    const html = await landing({ set: "classic" });
    for (const name of ["Muse Spark", "SAM 3.1", "Muse Image", "Muse Voice"]) expect(html).toContain(name);
    expect(html).toContain('href="https://github.com/MoriaCrew/Pinned/blob/main/docs/19-meta-models.md"');
    expect(html).toContain(`>${en["footer.source"]}</a>`);
  });
});
