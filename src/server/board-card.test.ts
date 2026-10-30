import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CARD_SIZE } from "../domain/board-card";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { mockElementNamer, mockSegmenter } from "../gateway/mock-ports";
import { resolvePolicy, type PolicyOverrides } from "../policy/policy";
import { confirmPins, createBoard, uploadPhoto, type BoardApiDeps } from "./board-api";
import {
  bakeSticker,
  cardBackgroundSvg,
  composePile,
  loadBoardCard,
  loadCardFonts,
  parseColor,
} from "./board-card";
import { boardCardImage, renderCardPng, type BoardCardImageDeps } from "./board-card-image";
import { joinBoard } from "./board-session";
import { InMemoryDecomposeJobStore } from "./decompose-job";
import { InMemoryDerivativeStore, type DerivativeStore } from "./derivative-store";
import { SKIN_IDS } from "../domain/skins";

/**
 * Board link card (PIN-102) against the in-memory repository and
 * the AI_MOCK ports: a real upload -> confirm flow feeds the card.
 */
const SECRET = "test-secret-test-secret-test-secret-32";
const RENDER_TIMEOUT = 30_000;

async function photoBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 320, height: 334, channels: 3, background: { r: 80, g: 120, b: 140 } },
  })
    .png()
    .toBuffer();
}

function harness(policyOverrides: PolicyOverrides = {}) {
  const boards = new InMemoryBoardRepository();
  const store = new InMemoryDerivativeStore();
  const policy = resolvePolicy(policyOverrides);
  let seq = 0;
  const api: BoardApiDeps = {
    boards,
    jobs: new InMemoryDecomposeJobStore(),
    store,
    namer: mockElementNamer,
    segmenter: mockSegmenter,
    policy,
    newId: () => `job-${++seq}`,
  };
  const card: BoardCardImageDeps = { boards, store, policyFor: (o) => resolvePolicy(o ?? {}) };
  // A ticking clock so join order is deterministic (no same-ms ties).
  let clock = Date.UTC(2026, 9, 30, 12, 0, 0);
  const session = { boards, sessionSecret: SECRET, policy, now: () => ++clock };
  return { boards, store, api, card, session };
}

/** Board with Robin (first) and Aye; Robin uploads one photo and pins `keep` of its 3 candidates. */
async function boardWithPins(h: ReturnType<typeof harness>, keep: number, themeId = "zine") {
  const board = await createBoard({ title: "Sam's 30th", themeId }, h.api);
  const robin = await joinBoard(board.slug, { displayName: "Robin" }, null, h.session);
  await joinBoard(board.slug, { displayName: "Aye" }, null, h.session);
  const job = await uploadPhoto(board.slug, robin.participant, await photoBytes(), h.api);
  if (keep > 0) {
    await confirmPins(board.slug, robin.participant, { jobId: job.id, pinIds: job.pinIds.slice(0, keep) }, h.api);
  }
  return { board, job };
}

async function pngInfo(res: Response) {
  const bytes = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(bytes).metadata();
  return { bytes, width: meta.width, height: meta.height, format: meta.format };
}

describe("loadBoardCard", () => {
  it("shows pinned cut-outs only, never the uploader's open candidates", async () => {
    const h = harness();
    const { board, job } = await boardWithPins(h, 2);
    const data = await loadBoardCard(board.slug, h.card);
    expect(data?.model).toMatchObject({
      skin: "zine",
      title: "Sam's 30th",
      inviter: "Robin",
      counts: { people: 2, things: 2, scenes: 0 },
    });
    const pinned = await h.boards.listPins(board.slug, "pinned");
    expect(data?.stickers.map((s) => s.id).sort()).toEqual(pinned.map((p) => p.elementId).sort());
    expect(data?.stickers).toHaveLength(2);
    // The confirm dropped the third candidate; nothing from tmp/ is read.
    expect(job.pinIds).toHaveLength(3);
    for (const sticker of data!.stickers) {
      expect((await sharp(sticker.bytes).metadata()).hasAlpha).toBe(true);
    }
  });

  it("shows no stickers while every pin is still a candidate", async () => {
    const h = harness();
    const { board } = await boardWithPins(h, 0);
    const data = await loadBoardCard(board.slug, h.card);
    expect(data?.stickers).toEqual([]);
    expect(data?.model.counts.things).toBe(0);
  });

  it("returns null for a malformed slug before any read, and for a missing board", async () => {
    const h = harness();
    const boards = new Proxy(h.boards, {
      get(target, prop) {
        if (prop === "getBoard") throw new Error("must not read");
        return Reflect.get(target, prop);
      },
    });
    expect(await loadBoardCard("../etc", { boards, store: h.store })).toBeNull();
    expect(await loadBoardCard("AAAAAAAAAAAAAAAAAAAAAA", h.card)).toBeNull();
  });

  it("leaves out a cut-out the store cannot read", async () => {
    const h = harness();
    const { board } = await boardWithPins(h, 2);
    let calls = 0;
    const flaky: DerivativeStore = {
      put: h.store.put.bind(h.store),
      delete: h.store.delete.bind(h.store),
      async get(ref) {
        if (calls++ === 0) throw new Error("storage hiccup");
        return h.store.get(ref);
      },
    };
    const data = await loadBoardCard(board.slug, { boards: h.boards, store: flaky });
    expect(data?.stickers).toHaveLength(1);
  });
});

describe("boardCardImage", () => {
  it(
    "draws a 1200x630 PNG for a board with pins, with the board's cache rule",
    async () => {
      const h = harness();
      const { board } = await boardWithPins(h, 3, "paper");
      const res = await boardCardImage(board.slug, h.card);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toBe(`private, max-age=${resolvePolicy({}).sceneImageCacheMaxAgeSeconds}`);
      const png = await pngInfo(res);
      expect(png).toMatchObject({ format: "png", width: CARD_SIZE.width, height: CARD_SIZE.height });
    },
    RENDER_TIMEOUT,
  );

  it(
    "answers a bad slug and a missing board with the same generic card (no existence leak)",
    async () => {
      const h = harness();
      const bad = await boardCardImage("a/b", h.card);
      const missing = await boardCardImage("AAAAAAAAAAAAAAAAAAAAAA", h.card);
      expect(bad.status).toBe(200);
      expect(missing.status).toBe(200);
      const [a, b] = [await pngInfo(bad), await pngInfo(missing)];
      expect(a.width).toBe(CARD_SIZE.width);
      expect(a.bytes.equals(b.bytes)).toBe(true);
    },
    RENDER_TIMEOUT,
  );

  it(
    "falls back to the generic card when loading the board fails",
    async () => {
      const h = harness();
      const boards = new Proxy(h.boards, {
        get(target, prop) {
          if (prop === "getBoard") return async () => Promise.reject(new Error("firestore down"));
          return Reflect.get(target, prop);
        },
      });
      const broken: BoardCardImageDeps = { ...h.card, boards };
      const res = await boardCardImage("AAAAAAAAAAAAAAAAAAAAAA", broken);
      expect(res.status).toBe(200);
      expect((await pngInfo(res)).width).toBe(CARD_SIZE.width);
    },
    RENDER_TIMEOUT,
  );

  it(
    "draws emoji and other-script titles offline without fetching fonts (and without failing)",
    async () => {
      const png = await renderCardPng({
        skin: "paper",
        invite: "Zoë 🌻 invited you to pin your things to",
        title: "Mia 🎉 誕生日",
        meta: "1 person",
        stickers: [],
      });
      expect((await sharp(png).metadata()).width).toBe(CARD_SIZE.width);
    },
    RENDER_TIMEOUT,
  );

  it(
    "draws an empty board with ghost outlines in every skin",
    async () => {
      for (const skin of SKIN_IDS) {
        const png = await renderCardPng({ skin, invite: "Pin your things to", title: "Empty", meta: "", stickers: [] });
        const meta = await sharp(png).metadata();
        expect([meta.width, meta.height]).toEqual([CARD_SIZE.width, CARD_SIZE.height]);
      }
    },
    RENDER_TIMEOUT,
  );
});

describe("sticker baking", () => {
  async function blob(): Promise<Buffer> {
    // A red disc on transparency, off-centre, with empty margins to trim.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><circle cx="150" cy="120" r="60" fill="#d00"/></svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  async function pixels(png: Buffer) {
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let white = 0;
    let dark = 0;
    for (let p = 0; p < data.length; p += 4) {
      if (data[p + 3] > 200 && data[p] > 240 && data[p + 1] > 240 && data[p + 2] > 240) white++;
      if (data[p + 3] > 200 && data[p] < 20 && data[p + 1] < 20 && data[p + 2] < 20) dark++;
    }
    return { white, dark, width: info.width, height: info.height };
  }

  it("adds a white keyline and a soft shadow on Paper", async () => {
    const baked = await bakeSticker(await blob(), { skin: "paper", size: 240, seed: "el-1" });
    expect(baked).not.toBeNull();
    const px = await pixels(baked!.png);
    expect(px.white).toBeGreaterThan(500);
    expect(px.dark).toBe(0);
    expect(baked!.width).toBeGreaterThan(240);
  });

  it("uses a hard black offset shadow and no keyline on Zine", async () => {
    const baked = await bakeSticker(await blob(), { skin: "zine", size: 240, seed: "el-1" });
    const px = await pixels(baked!.png);
    expect(px.white).toBe(0);
    expect(px.dark).toBeGreaterThan(500);
  });

  it("skips a cut-out with no visible pixels", async () => {
    const empty = await sharp({ create: { width: 50, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    expect(await bakeSticker(empty, { skin: "paper", size: 200, seed: "x" })).toBeNull();
  });

  it("piles what decodes and gives up (ghosts) when nothing does", async () => {
    const good = await blob();
    const pile = await composePile([{ id: "a", bytes: Buffer.from("not an image") }, { id: "b", bytes: good }], "cork");
    expect(pile).not.toBeNull();
    expect((await sharp(pile!).metadata()).width).toBe(CARD_SIZE.width);
    expect(await composePile([{ id: "a", bytes: Buffer.from("not an image") }], "cork")).toBeNull();
  });
});

describe("card pieces", () => {
  it("parses token colours", () => {
    expect(parseColor("#d93a17")).toEqual({ r: 217, g: 58, b: 23, alpha: 1 });
    expect(parseColor("rgba(40, 28, 12, 0.32)")).toEqual({ r: 40, g: 28, b: 12, alpha: 0.32 });
    expect(() => parseColor("tomato")).toThrow();
  });

  it("draws Postcard's airmail band, Marigold's papel picado and ghosts on request", () => {
    expect(cardBackgroundSvg("postcard", { ghosts: false })).toContain('patternTransform="rotate(45)"');
    expect(cardBackgroundSvg("marigold", { ghosts: false })).toContain("<polygon");
    expect(cardBackgroundSvg("paper", { ghosts: false })).not.toContain("stroke-dasharray");
    expect(cardBackgroundSvg("paper", { ghosts: true }).match(/stroke-dasharray/g)).toHaveLength(3);
    expect(cardBackgroundSvg("darkroom", { ghosts: false })).toContain('fill="#141110"');
  });

  it("loads the reading, mono, wordmark and display faces for every skin", async () => {
    for (const skin of SKIN_IDS) {
      const fonts = await loadCardFonts(skin);
      expect(fonts.map((f) => f.name)).toEqual(
        expect.arrayContaining(["Atkinson Hyperlegible Next", "Atkinson Hyperlegible Mono", "Bricolage Grotesque"]),
      );
      for (const font of fonts) expect(font.data.byteLength).toBeGreaterThan(10_000);
    }
    expect((await loadCardFonts("darkroom")).find((f) => f.name === "Instrument Serif")?.style).toBe("italic");
  });
});
