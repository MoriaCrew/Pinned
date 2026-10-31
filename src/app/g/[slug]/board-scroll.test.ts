import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardScenes, type SceneSlot } from "./BoardScenes";
import {
  pinAtScreenMiddle,
  pinInMiddleOfScreen,
  prefersReducedMotion,
  revealScenes,
  scrollBehaviorFor,
} from "./board-scroll";

const source = readFileSync(path.join(process.cwd(), "src/app/g/[slug]/BoardClient.tsx"), "utf8");
/** The body of a function declared in BoardClient, up to its closing brace at the same indent. */
const bodyOf = (name: string) => {
  const start = source.indexOf(`  function ${name}(`);
  expect(start, `${name} is declared`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n  }\n", start));
};

/** A Scenes section as the DOM gives it: heading, then the sideways strip. */
function sceneDom() {
  const strip = { scrollTo: vi.fn() };
  const heading = {
    scrollIntoView: vi.fn(),
    focus: vi.fn(),
    closest: vi.fn((selector: string) => (selector === "section" ? { querySelector: (s: string) => (s === "ul" ? strip : null) } : null)),
  };
  const doc = { getElementById: vi.fn((id: string) => (id === "board-scenes" ? heading : null)) };
  return { strip, heading, doc: doc as unknown as Pick<Document, "getElementById"> };
}

afterEach(() => vi.unstubAllGlobals());

describe("scrolling to the developing scene (PIN-215)", () => {
  it("scrolls smoothly, and not at all smoothly under reduced motion", () => {
    expect(scrollBehaviorFor(false)).toBe("smooth");
    expect(scrollBehaviorFor(true)).toBe("auto");
  });

  it("reads the reduced-motion preference, and treats a missing matchMedia as no preference", () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" }));
    vi.stubGlobal("window", { matchMedia });
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal("window", {});
    expect(prefersReducedMotion()).toBe(false);
  });

  it("brings the Scenes heading to the top, winds the strip back and focuses the heading without a second scroll", () => {
    const { doc, heading, strip } = sceneDom();
    expect(revealScenes(doc, false)).toBe(true);
    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    expect(strip.scrollTo).toHaveBeenCalledWith({ left: 0, behavior: "smooth" });
    expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("jumps instead of gliding under reduced motion", () => {
    const { doc, heading, strip } = sceneDom();
    revealScenes(doc, true);
    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
    expect(strip.scrollTo).toHaveBeenCalledWith({ left: 0, behavior: "auto" });
  });

  it("does nothing when the Scenes section is not on the page", () => {
    expect(revealScenes({ getElementById: () => null }, false)).toBe(false);
  });

  it("finds a heading that can take focus and a strip to wind back in the Scenes markup", () => {
    const developing: SceneSlot = { type: "developing", ratio: "3 / 2", id: "s1", stickers: [], idea: "a picnic", startedAt: null };
    const out = renderToStaticMarkup(h(BoardScenes, { slots: [developing], count: 1 }));
    expect(out).toContain('<h2 class="pn-section-title" id="board-scenes" tabindex="-1">');
    expect(out.indexOf("<section")).toBeLessThan(out.indexOf("<ul"));
    expect(out).toContain('data-scene-id="s1"');
    expect(out).toContain('role="status"'); // the developing card announces itself
  });
});

describe("the board keeps your place when you start a scene (PIN-215)", () => {
  const box = (id: string, top: number) => ({ id, top, bottom: top + 120 });
  const rows = [box("a", -300), box("b", -100), box("c", 100), box("d", 300), box("e", 500), box("f", 700)];

  it("names the pin at the middle of an 844 px screen", () => {
    // The middle line is 422 px down: pin d spans 300-420, e spans 500-620.
    expect(pinAtScreenMiddle(rows, 844)).toBe("d");
    expect(pinAtScreenMiddle([box("x", 400)], 844)).toBe("x");
  });

  it("takes the nearest pin when the middle falls between two rows", () => {
    expect(pinAtScreenMiddle([box("up", 250), box("down", 450)], 800)).toBe("up");
    expect(pinAtScreenMiddle([box("up", 200), box("down", 330)], 800)).toBe("down");
  });

  it("names none when the middle is above the grid (top of the board) or below it, or there are no pins", () => {
    expect(pinAtScreenMiddle([box("first", 600), box("next", 800)], 844)).toBeNull();
    expect(pinAtScreenMiddle([box("last", -400), box("end", -200)], 844)).toBeNull();
    expect(pinAtScreenMiddle([], 844)).toBeNull();
  });

  it("reads each pin's box from the page", () => {
    const element = (id: string, top: number) => ({ dataset: { pinId: id }, getBoundingClientRect: () => ({ top, bottom: top + 120 }) });
    const doc = { querySelectorAll: () => [element("p1", 100), element("p2", 380)] } as unknown as Pick<Document, "querySelectorAll">;
    expect(pinInMiddleOfScreen(doc, 800)).toBe("p2");
  });

  it("wires Make it to the Scenes, once the card is on the page, and the dock to the pin in the middle", () => {
    // Make it remembers the new scene, and the effect scrolls only when its card exists.
    expect(bodyOf("submitScene")).toContain("setScrollToSceneId(sceneAttempt.sceneId)");
    expect(source).toMatch(/slots\.some\(\(slot\) => slot\.id === scrollToSceneId\)/);
    expect(source).toMatch(/revealScenes\(document, prefersReducedMotion\(\)\);\s+setScrollToSceneId\(null\);/);
    // Starting from the dock no longer jumps to the top; it keeps the pin in the middle of the screen.
    expect(bodyOf("startPicking")).not.toContain("scrollTo");
    expect(source).toMatch(/setRemixOfId\(null\);[^]*?setScrollToPinId\(pinInMiddleOfScreen\(document, window\.innerHeight\)\);\s+startPicking\(\);/);
    // Remix still opens at the top, where its hint is.
    expect(bodyOf("startRemix")).toContain("window.scrollTo({ top: 0 })");
  });
});
