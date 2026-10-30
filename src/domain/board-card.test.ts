import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import tokens from "../ui/tokens.json";
import {
  CARD_MAX_STICKERS,
  CARD_SIZE,
  CARD_SKIN_STYLES,
  GHOST_SLOTS,
  cardInviteLine,
  cardMetaLine,
  cardModel,
  cardStickerTilt,
  cardText,
  cardTitleSize,
  cardTitleText,
  pileSlots,
  type CardModelInput,
} from "./board-card";
import { SKIN_IDS, stickerTilt, type SkinId } from "./skins";

const SLUG = "AAAAAAAAAAAAAAAAAAAAAA";

function input(overrides: Partial<CardModelInput> = {}): CardModelInput {
  return {
    board: { slug: SLUG, title: "Mia's 7th birthday", themeId: "paper" },
    participants: [],
    pins: [],
    elements: [],
    scenes: [],
    ...overrides,
  };
}

function element(id: string, extra: Partial<{ boardId: string; cutoutRef: string }> = {}) {
  return { id, boardId: SLUG, cutoutRef: `elements/boards/${SLUG}/${id}/cutout.png`, ...extra };
}

function pin(id: string, elementId: string, createdAt: number, status: "pinned" | "candidate" = "pinned") {
  return { id, elementId, status, createdAt };
}

describe("cardModel (PIN-102)", () => {
  it("names the earliest participant as the inviter", () => {
    const model = cardModel(
      input({
        participants: [
          { id: "p2", displayName: "Aye", createdAt: 20 },
          { id: "p1", displayName: " Robin ", createdAt: 10 },
        ],
      }),
    );
    expect(model.inviter).toBe("Robin");
    expect(model.counts.people).toBe(2);
  });

  it("drops the inviter when nobody joined yet", () => {
    expect(cardModel(input()).inviter).toBeNull();
    expect(cardInviteLine(null)).toBe("Pin your things to");
    expect(cardInviteLine("Robin")).toBe("Robin invited you to pin your things to");
  });

  it("piles only pinned elements of this board with a stored cut-out, newest first", () => {
    const model = cardModel(
      input({
        elements: [
          element("old"),
          element("new"),
          element("cand"),
          element("other-board", { boardId: "BBBBBBBBBBBBBBBBBBBBBB" }),
          element("working-copy", { cutoutRef: "tmp/x/working.webp" }),
        ],
        pins: [
          pin("a", "old", 1),
          pin("b", "new", 3),
          pin("c", "cand", 5, "candidate"),
          pin("d", "other-board", 6),
          pin("e", "working-copy", 7),
          pin("f", "deleted-element", 8),
        ],
      }),
    );
    expect(model.stickerIds).toEqual(["new", "old"]);
    expect(model.counts.things).toBe(2);
  });

  it("caps the pile at the design's five stickers but counts every thing", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `e${i}`);
    const model = cardModel(
      input({ elements: ids.map((id) => element(id)), pins: ids.map((id, i) => pin(`p${i}`, id, i)) }),
    );
    expect(CARD_MAX_STICKERS).toBe(5);
    expect(model.stickerIds).toEqual(["e7", "e6", "e5", "e4", "e3"]);
    expect(model.counts.things).toBe(8);
  });

  it("counts ready, visible scenes only", () => {
    const model = cardModel(
      input({
        scenes: [
          { status: "ready" },
          { status: "ready", hidden: true },
          { status: "pending" },
          { status: "failed" },
        ],
      }),
    );
    expect(model.counts.scenes).toBe(1);
  });

  it("renders the board's skin; old theme ids map, unknown ones fall back to Paper", () => {
    expect(cardModel(input({ board: { slug: SLUG, title: "x", themeId: "zine" } })).skin).toBe("zine");
    expect(cardModel(input({ board: { slug: SLUG, title: "x", themeId: "gran" } })).skin).toBe("cork");
    expect(cardModel(input({ board: { slug: SLUG, title: "x", themeId: "nope" } })).skin).toBe("paper");
    expect(cardModel(input({ board: { slug: SLUG, title: "x" } })).skin).toBe("paper");
  });
});

describe("card text", () => {
  it("keeps Latin text and drops what the bundled fonts cannot draw", () => {
    expect(cardText("Zoë's “party” — 30€")).toBe("Zoë's “party” — 30€");
    expect(cardText("Sam's 30th 🎉🎂")).toBe("Sam's 30th");
    expect(cardText("👨‍👩‍👧 Family  board")).toBe("Family board");
    expect(cardText("誕生日")).toBe("");
  });

  it("falls back to the brand line when no title glyph is left, and drops an undrawable inviter", () => {
    const model = cardModel(
      input({
        board: { slug: SLUG, title: "🎉🎉", themeId: "paper" },
        participants: [{ id: "p1", displayName: "🌻", createdAt: 1 }],
      }),
    );
    expect(model.title).toBe("Everyone's things, pinned.");
    expect(model.inviter).toBeNull();
    expect(cardModel(input({ board: { slug: SLUG, title: " Mia 🎈 7 ", themeId: "paper" } })).title).toBe("Mia 7");
  });
});

describe("card copy", () => {
  it("leaves zero counts out of the meta line", () => {
    expect(cardMetaLine({ people: 6, things: 14, scenes: 0 })).toBe("6 people · 14 things");
    expect(cardMetaLine({ people: 1, things: 1, scenes: 1 })).toBe("1 person · 1 thing · 1 scene");
    expect(cardMetaLine({ people: 0, things: 0, scenes: 0 })).toBe("");
  });

  it("sets Zine titles in capitals only", () => {
    expect(cardTitleText("Sam's 30th", "zine")).toBe("SAM'S 30TH");
    expect(cardTitleText("Sam's 30th", "paper")).toBe("Sam's 30th");
  });

  it("steps the title down for long names and long words", () => {
    const short = cardTitleSize("Lisbon, June", "paper");
    expect(short).toBeCloseTo(81.6, 1);
    expect(cardTitleSize("Lisbon, June", "darkroom")).toBeGreaterThan(short);
    expect(cardTitleSize("The whole family reunion at the lake house", "paper")).toBeLessThan(short * 0.7);
    expect(cardTitleSize("Supercalifragilistic", "paper")).toBeLessThan(short);
    const longest = cardTitleSize("x".repeat(80), "paper");
    expect(longest).toBeGreaterThan(30);
  });
});

describe("card layout", () => {
  it("keeps every pile inside the card, right of the copy column", () => {
    for (let n = 0; n <= CARD_MAX_STICKERS + 2; n++) {
      const slots = pileSlots(n);
      expect(slots).toHaveLength(Math.min(n, CARD_MAX_STICKERS));
      for (const slot of [...slots, ...GHOST_SLOTS]) {
        expect(slot.x).toBeGreaterThanOrEqual(CARD_SIZE.width * 0.5);
        expect(slot.x + slot.size).toBeLessThanOrEqual(CARD_SIZE.width);
        expect(slot.y).toBeGreaterThanOrEqual(0);
        expect(slot.y + slot.size).toBeLessThanOrEqual(CARD_SIZE.height);
      }
    }
  });

  it("uses the design's five-sticker pile (LinkPreview, in cqw)", () => {
    expect(pileSlots(5)[0]).toEqual({ x: 696, y: 36, size: 288 });
    expect(pileSlots(5)[4]).toEqual({ x: 804, y: 180, size: 216 });
  });

  it("gives each thing a stable lean within the skin's tilt", () => {
    expect(cardStickerTilt("el-1", "cork")).toBe(cardStickerTilt("el-1", "cork"));
    expect(cardStickerTilt("el-1", "cork")).toBeCloseTo(stickerTilt("el-1") * 5, 5);
    expect(cardStickerTilt("el-1", "darkroom")).toBe(0);
  });
});

/**
 * Drift guard: the card mirrors each skin's look from
 * src/ui/pinneds.css (the renderer cannot read CSS variables).
 */
describe("card skin styles match pinneds.css", () => {
  const css = readFileSync(path.join(process.cwd(), "src/ui/pinneds.css"), "utf8");
  const tilts = Object.fromEntries(tokens.tilt.tokens.map((tk) => [tk.name, parseFloat(tk.value)]));

  function block(skin: SkinId): Record<string, string> {
    const base = /:root, \[data-theme\] \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const own = skin === "paper" ? "" : new RegExp(`\\[data-theme="${skin}"\\] \\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? "";
    const vars: Record<string, string> = {};
    for (const text of [base, own]) {
      for (const m of text.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
    }
    return vars;
  }

  function px(value: string): number {
    const keyline = /var\(--keyline-(\d)\)/.exec(value);
    return keyline ? Number(keyline[1]) : parseFloat(value);
  }

  it.each(SKIN_IDS)("%s", (skin) => {
    const v = block(skin);
    const style = CARD_SKIN_STYLES[skin];
    expect(style.display.scale).toBe(parseFloat(v["--display-scale"]));
    expect(style.display.trackingEm).toBeCloseTo(parseFloat(v["--display-tracking"]) || 0, 5);
    expect(style.display.uppercase).toBe(v["--display-transform"] === "uppercase");
    expect(style.display.style).toBe(v["--display-style"]);
    // Static font instances: the nearest available weight.
    expect(Math.abs(style.display.weight - Number(v["--display-weight"]))).toBeLessThanOrEqual(50);
    expect(style.tiltDeg).toBe(tilts[/var\(--(tilt-\d)\)/.exec(v["--tilt"])?.[1] ?? ""]);
    expect(style.keylinePx).toBe(px(v["--kw"]));
    const lift = /drop-shadow\((-?[\d.]+)(?:px)? (-?[\d.]+)px (-?[\d.]+)(?:px)?/.exec(v["--lift"]);
    expect(lift).not.toBeNull();
    expect(style.lift).toEqual({ x: Number(lift![1]), y: Number(lift![2]), blur: Number(lift![3]) });
    expect(style.pushpin).toBe(v["--pushpin"] === "block");
    expect(style.band !== null).toBe(v["--band-show"] === "block");
    expect(style.ground !== null).toBe(v["--board-pattern"] !== "none");
  });
});
