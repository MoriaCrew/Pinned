import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { emptyBoardCounters } from "../../../domain/board";
import { CARD_SIZE } from "../../../domain/board-card";
import { generateSlug } from "../../../domain/tokens";
import { getBoardRepository } from "../../../server/board-repository";
import { getDerivativeStore } from "../../../server/derivative-store";
import Image, { alt, contentType, size } from "./opengraph-image";
import TwitterImage, { size as twitterSize } from "./twitter-image";

/**
 * Route wiring for the board link card (PIN-102) on the memory
 * backends: the file-convention exports Next reads, a seeded board,
 * and a bad slug (still a 200 PNG, never a 500).
 */
const RENDER_TIMEOUT = 30_000;

async function seedBoard(): Promise<string> {
  const slug = generateSlug();
  const boards = getBoardRepository();
  await boards.createBoard({ slug, title: "Lisbon, June", themeId: "postcard", counters: emptyBoardCounters(), createdAt: 1, version: 1 });
  await boards.putParticipant({ id: "p1", boardId: slug, displayName: "Aye", cookieSecretHash: "x", createdAt: 2 });
  const cutoutRef = `elements/boards/${slug}/el-1/cutout.png`;
  const disc = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="80" fill="#2c5aa0"/></svg>`;
  await getDerivativeStore().put(cutoutRef, await sharp(Buffer.from(disc)).png().toBuffer(), "image/png");
  await boards.createElement({
    id: "el-1",
    boardId: slug,
    ownerId: "p1",
    label: "Blue plate",
    description: "",
    maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
    cutoutRef,
    flattenedRef: `elements/boards/${slug}/el-1/flattened.jpg`,
    sourcePhotoId: "job-1",
    faceFlag: false,
    createdAt: 3,
  });
  await boards.createPin({ id: "pin-1", boardId: slug, elementId: "el-1", pinnedBy: "p1", status: "pinned", createdAt: 4 });
  return slug;
}

describe("/g/[slug]/opengraph-image", () => {
  it("declares the Open Graph size, type and alt Next puts in the meta tags", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(twitterSize).toEqual(size);
    expect(contentType).toBe("image/png");
    expect(alt.length).toBeGreaterThan(0);
  });

  it(
    "renders the card for a board and the generic card for a bad slug",
    async () => {
      const slug = await seedBoard();
      for (const res of [
        await Image({ params: Promise.resolve({ slug }) }),
        await TwitterImage({ params: Promise.resolve({ slug }) }),
        await Image({ params: Promise.resolve({ slug: "..%2F.." }) }),
      ]) {
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
        expect([meta.width, meta.height]).toEqual([CARD_SIZE.width, CARD_SIZE.height]);
      }
    },
    RENDER_TIMEOUT,
  );
});
