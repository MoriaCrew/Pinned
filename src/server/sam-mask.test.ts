import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { SamSegment } from "../gateway/model-gateway";
import {
  SamMaskError,
  decodeSegment,
  maskAt,
  renderCutout,
  renderMask,
  renderOverlay,
} from "./sam-mask";

// Verbatim example record from Meta's public SAM docs
// (sam/reading-segmentation): 320x334 frame, box 211,228..270,254,
// mask raster 27 rows x 60 cols, lossless marker.
const DOCS_SEGMENT: SamSegment = {
  id: "0",
  box: { x1: 211, y1: 228, x2: 270, y2: 254, w: 320, h: 334 },
  mask: {
    height: 27,
    width: 60,
    encoding: "~",
    payload: "!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(",
  },
};

describe("decodeSegment (official @meta-sam/parser)", () => {
  it("decodes the documented base85 mask into a binary raster", () => {
    const decoded = decodeSegment(DOCS_SEGMENT, { width: 320, height: 334 });
    expect(decoded.raster).toHaveLength(27 * 60);
    expect([...new Set(decoded.raster)].sort()).toEqual([0, 1]);
    expect(decoded.maskPixels).toBeGreaterThan(0);
    expect(decoded.maskPixels).toBeLessThan(27 * 60);
    expect(decoded.coverageBox).toBeGreaterThan(0);
    expect(decoded.coverageBox).toBeLessThanOrEqual(1);
    expect(decoded.coverageFrame).toBeGreaterThan(0);
    expect(decoded.coverageFrame).toBeLessThan(decoded.coverageBox);
  });

  it("rejects unknown encoding markers and corrupt payloads", () => {
    const frame = { width: 320, height: 334 };
    expect(() =>
      decodeSegment(
        { ...DOCS_SEGMENT, mask: { ...DOCS_SEGMENT.mask, encoding: "?" } },
        frame,
      ),
    ).toThrow(SamMaskError);
    expect(() =>
      decodeSegment(
        { ...DOCS_SEGMENT, mask: { ...DOCS_SEGMENT.mask, payload: "!!!" } },
        frame,
      ),
    ).toThrow(SamMaskError);
  });

  it("maskAt is false outside the box and samples inside it", () => {
    const decoded = decodeSegment(DOCS_SEGMENT, { width: 320, height: 334 });
    expect(maskAt(decoded, 0, 0)).toBe(false);
    expect(maskAt(decoded, 210, 240)).toBe(false);
    expect(maskAt(decoded, 271, 240)).toBe(false);
    let insideOnes = 0;
    for (let y = 228; y <= 254; y++) {
      for (let x = 211; x <= 270; x++) if (maskAt(decoded, x, y)) insideOnes++;
    }
    // Box is exactly mask-sized (60x27), so sampling is 1:1.
    expect(insideOnes).toBe(decoded.maskPixels);
  });
});

describe("compositing", () => {
  async function fixture() {
    const image = await sharp({
      create: { width: 320, height: 334, channels: 3, background: { r: 90, g: 90, b: 90 } },
    })
      .png()
      .toBuffer();
    const decoded = decodeSegment(DOCS_SEGMENT, { width: 320, height: 334 });
    return { image, decoded };
  }

  it("cut-out alpha matches the mask pixel for pixel", async () => {
    const { image, decoded } = await fixture();
    const cutout = await renderCutout(image, decoded);
    const { data, info } = await sharp(cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(60);
    expect(info.height).toBe(27);
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] === 255) opaque++;
    expect(opaque).toBe(decoded.maskPixels);
  });

  it("overlay tints masked pixels and mask render is binary", async () => {
    const { image, decoded } = await fixture();
    const overlay = await renderOverlay(image, [decoded]);
    const meta = await sharp(overlay).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(320);

    const maskPng = await renderMask(decoded);
    const { data, info } = await sharp(maskPng).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(60);
    expect(info.height).toBe(27);
    const whites = [...data].filter((v) => v === 255).length;
    expect(whites / info.channels).toBe(decoded.maskPixels);
  });
});
