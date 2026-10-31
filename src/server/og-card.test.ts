import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CARD_SIZE } from "../domain/board-card";
import { genericCardView, renderCardPng } from "./board-card-image";

// The last-resort link image (PIN-203): the generic Pinneds card,
// saved as a static PNG for when even the generic render fails.
// Regenerate after changing the card design or `card.fallback*`
// copy: `npm run og:card` (writes both copies), then commit them.
const ROOT = path.resolve(__dirname, "..", "..");
const FILES = [
  path.join(ROOT, "public", "og-card.png"),
  path.join(ROOT, "src", "server", "og-assets", "og-card.png"),
];

describe("static og-card.png (PIN-203)", () => {
  it.skipIf(!process.env.WRITE_OG_CARD)("writes the generic card to both copies", async () => {
    const png = await renderCardPng(genericCardView());
    for (const file of FILES) writeFileSync(file, png);
  });

  it("ships one card-sized image, identical in both places", async () => {
    const [publicCopy, serverCopy] = FILES.map((file) => readFileSync(file));
    expect(publicCopy.equals(serverCopy!)).toBe(true);
    const meta = await sharp(publicCopy!).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual(CARD_SIZE);
  });
});
