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

  it("links Privacy, Terms and the source from the footer (PIN-26)", async () => {
    const html = await landing({ set: "classic" });
    const foot = /<footer class="pn-landing-foot">([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";
    expect(foot).toContain(`<a href="/privacy">${en["footer.privacy"]}</a>`);
    expect(foot).toContain(`<a href="/terms">${en["footer.terms"]}</a>`);
    expect(foot).toContain(`<a href="https://github.com/MoriaCrew/Pinned">${en["footer.source"]}</a>`);
    expect(foot).toContain(`aria-label="${en["footer.label"]}"`);
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

  it("keeps the model names as product names and links the models page and the source", async () => {
    const html = await landing({ set: "classic" });
    for (const name of ["Muse Spark", "SAM 3.1", "Muse Image", "Muse Voice"]) expect(html).toContain(name);
    // PIN-237: the in-app explainer, not the developer doc on GitHub.
    expect(html).toContain(`<a href="/models">${en["landing.meta.more"]}</a>`);
    expect(html).not.toContain("docs/19-meta-models.md");
    expect(html).toContain(`>${en["footer.source"]}</a>`);
  });
});

describe("landing 'See a board' demo form (PIN-251)", () => {
  // The config is read per request, so the two cases run with the real
  // module and a spy on getConfig: demo on (a template slug) and off.
  const demoOn = async () => {
    const config = await import("../config");
    const real = config.getConfig();
    vi.spyOn(config, "getConfig").mockReturnValue({ ...real, demoBoardSlug: "tmplAAAAAAAAAAAAAAAAA1" });
  };

  it("posts to /api/demo instead of linking any board, and says what the visitor gets", async () => {
    await demoOn();
    const html = await landing({ set: "classic" });
    const form = /<form [^>]*>[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
    expect(form).toContain('method="post"');
    expect(form).toContain('action="/api/demo"');
    expect(form).toMatch(/<button [^>]*type="submit"[^>]*>/);
    expect(form).toContain(en["landing.demo"]);
    // No board link anywhere on the page: not the template, not the judges' board.
    expect(html).not.toMatch(/href="\/g\//);
    expect(html).not.toContain("tmplAAAAAAAAAAAAAAAAA1");
    expect(html).toContain(en["landing.demoNote.other"].replace("{n}", "24"));
  });

  it("shows no demo button and no note without a template", async () => {
    const html = await landing({ set: "classic" });
    expect(html).not.toContain('action="/api/demo"');
    expect(html).not.toContain(en["landing.demo"]);
    expect(html).not.toContain("disappears after");
    expect(html).not.toMatch(/href="\/g\//);
  });

  it("shows the route's notice from ?demo= and ignores unknown values", async () => {
    await demoOn();
    expect(await landing({ demo: "busy" })).toContain(en["landing.demoBusy"]);
    expect(await landing({ demo: "unavailable" })).toContain(en["landing.demoUnavailable"]);
    const plain = await landing({ demo: "nope" });
    expect(plain).not.toContain(en["landing.demoBusy"]);
    expect(plain).not.toContain(en["landing.demoUnavailable"]);
  });
});

describe("judging-week links (PIN-263)", () => {
  const withLinks = async (links: { demoVideoUrl: string | null; promoPostUrl: string | null }) => {
    const config = await import("../config");
    const real = config.getConfig();
    vi.spyOn(config, "getConfig").mockReturnValue({ ...real, demoBoardSlug: "tmplAAAAAAAAAAAAAAAAA1", ...links });
  };
  const anchor = (html: string, href: string) => new RegExp(`<a [^>]*href="${href.replace(/[.?/]/g, "\\$&")}"[^>]*>[\\s\\S]*?</a>`).exec(html)?.[0] ?? "";

  it("closes How it works with the demo video and puts the post in the footer, both opening a new tab", async () => {
    await withLinks({ demoVideoUrl: "https://youtu.be/q6lkrA6fsCI", promoPostUrl: "https://x.com/MoriaCrew/status/1" });
    const html = await landing({ set: "classic" });
    const video = anchor(html, "https://youtu.be/q6lkrA6fsCI");
    expect(video).toContain(en["landing.video"]);
    expect(video).toContain('target="_blank"');
    expect(video).toContain('rel="noopener noreferrer"');
    expect(video).toContain(en["landing.newTab"]);
    // Inside "How it works", after the steps.
    const how = /<section class="pn-landing-how"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(how).toContain("https://youtu.be/q6lkrA6fsCI");
    const post = anchor(html, "https://x.com/MoriaCrew/status/1");
    expect(post).toContain(en["landing.xPost"]);
    expect(post).toContain('target="_blank"');
    expect(post).toContain('rel="noopener noreferrer"');
    const foot = /<footer[\s\S]*?<\/footer>/.exec(html)?.[0] ?? "";
    expect(foot).toContain("https://x.com/MoriaCrew/status/1");
    // A link out, never an embedded player or widget.
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("platform.twitter.com");
  });

  it("shows neither link while its URL is unset", async () => {
    await withLinks({ demoVideoUrl: null, promoPostUrl: null });
    const html = await landing({ set: "classic" });
    expect(html).not.toContain(en["landing.video"]);
    expect(html).not.toContain(en["landing.xPost"]);
  });

  it("labels the demo button Demo board with the launch icon", async () => {
    await withLinks({ demoVideoUrl: null, promoPostUrl: null });
    const form = /<form [^>]*>[\s\S]*?<\/form>/.exec(await landing({ set: "classic" }))?.[0] ?? "";
    expect(en["landing.demo"]).toBe("Demo board");
    expect(form).toContain(en["landing.demo"]);
  });
});
