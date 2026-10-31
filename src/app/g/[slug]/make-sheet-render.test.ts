import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PinCard } from "../../../domain/board-view";
import { MakeSheet } from "./MakeSheet";

const card = (pinId: string, label: string): PinCard => ({
  pinId,
  element: { id: `e-${pinId}`, ownerId: "me", label, faceFlag: false, imageUrl: `/img/${pinId}` },
  status: "pinned",
  ownerName: "Robin",
  ownerId: "me",
  createdAt: 0,
});

const FIXED = ["on a sunny picnic blanket", "in a tiny museum"];
const noop = () => {};

function sheet(over: Partial<Parameters<typeof MakeSheet>[0]> = {}) {
  return renderToStaticMarkup(
    h(MakeSheet, {
      cards: [card("p1", "Teal Mug"), card("p2", "Rubber Duck")],
      chips: FIXED,
      fixedChips: FIXED,
      pinsPerScene: { min: 1, max: 4 },
      promptMaxChars: 500,
      initialPrompt: "",
      dictate: { slug: "b", maxSeconds: 30 },
      onMake: noop,
      onRemovePick: noop,
      onAddPicks: noop,
      onClose: noop,
      ...over,
    }),
  );
}

describe("Make sheet as a chat-style composer (PIN-216)", () => {
  it("shows the picks as a compact strip: tap to drop, + to pick more, n of max", () => {
    const out = sheet();
    expect(out).toContain('aria-label="Remove Teal Mug"');
    expect(out).toContain('aria-label="Remove Rubber Duck"');
    expect(out).toContain('aria-label="Pick more pins"');
    expect(out).toContain("2 of 4 picked");
    // No owner rows or name tags any more: the strip is stickers only.
    expect(out).not.toContain("pn-pin-owner");
    const full = sheet({ cards: ["a", "b", "c", "d"].map((id) => card(id, id)) });
    expect(full).not.toContain("Pick more pins");
  });

  it("puts the ideas in one row, adds generated chips after the fixed ones, and drops Write your own", () => {
    const out = sheet({ chips: ["a tiny parade starring the rubber duck"], chipsLoading: false });
    const row = out.match(/<div class="pn-chip-row pn-make-chips"[^]*?<\/div>/)?.[0] ?? "";
    const order = [...row.matchAll(/<button[^>]*>(?:<img[^>]*>)?([^<]+)/g)].map((m) => m[1]);
    expect(order).toEqual([...FIXED, "a tiny parade starring the rubber duck"]);
    // Only the chip that names a pick wears its sticker.
    expect(row.match(/pn-chip-thumb/g)).toHaveLength(1);
    expect(row).toContain('src="/img/p2"');
    expect(out).not.toContain("Write your own");
  });

  it("shows a non-interactive loading chip while generated ideas are on their way", () => {
    const out = sheet({ chipsLoading: true });
    expect(out).toMatch(/<span class="pn-chip pn-chip-loading" aria-busy="true">Finding more ideas…<\/span>/);
    expect(sheet()).not.toContain("pn-chip-loading");
  });

  it("marks a chip pressed when the idea holds it", () => {
    const out = sheet({ initialPrompt: "a tea party, In a tiny museum" });
    expect(out).toMatch(/aria-pressed="true"[^>]*>in a tiny museum/);
    expect(out).toMatch(/aria-pressed="false"[^>]*>on a sunny picnic blanket/);
  });

  it("is the sheet's foot: one-line field, labelled Make it, no count until near the cap", () => {
    const out = sheet({ initialPrompt: "a tea party" });
    const foot = out.match(/<div class="pn-sheet-foot">[^]*$/)?.[0] ?? "";
    expect(foot).toMatch(/<textarea[^>]*id="scene-prompt"[^>]*rows="1"/);
    expect(foot).toMatch(/<button[^>]*pn-btn-primary[^>]*>Make it<\/button>/);
    expect(foot).not.toContain("/500");
    expect(sheet({ initialPrompt: "x".repeat(420) })).toContain("420/500");
    // Nothing valid to make yet: Make it is off.
    expect(sheet()).toMatch(/<button[^>]*disabled=""[^>]*>Make it/);
  });

  it("in remix mode names the base scene on one clamped line with the full idea in its title", () => {
    const prompt = "Everyone's things dancing a conga line around grandma's cake";
    const out = sheet({ remixParent: { id: "s1", imageUrl: "/img/s1", prompt, ratio: "2 / 3" } });
    expect(out).toContain(`title="${prompt.replace(/'/g, "&#x27;")}"`);
    expect(out).toContain("Remix of “Everyone&#x27;s things dancing");
    expect(out).toContain("pn-make-base-text");
    expect(out).toContain("Remix this scene");
  });

  it("keeps the idea when going back to pick more or closing, and never wipes it from a chip", () => {
    const board = readFileSync(path.join(__dirname, "BoardClient.tsx"), "utf8");
    expect(board).toMatch(/onAddPicks=\{\(prompt\) => \{\s*setSheetPrompt\(prompt\);/);
    expect(board).toMatch(/onClose=\{\(prompt\) => \{\s*setSheetPrompt\(prompt\);/);
    const source = readFileSync(path.join(__dirname, "MakeSheet.tsx"), "utf8");
    expect(source).not.toContain('setPrompt("")');
  });

  it("treats fixed and generated chips alike as known, so tapping one after another swaps", () => {
    // Bugbot on PR #188: knownChips followed only the generated list while the row also shows the fixed chips.
    const source = readFileSync(path.join(__dirname, "MakeSheet.tsx"), "utf8");
    expect(source).toMatch(/const ideas = ideaChips\(fixedChips, chips\);/);
    expect(source).toMatch(/useState<readonly string\[\]>\(ideas\)/);
    expect(source).not.toMatch(/useState<readonly string\[\]>\(chips\)/);
  });
});
