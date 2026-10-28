import "server-only";
/**
 * SAM mask decoding + compositing (PIN-36 lab, reused by PIN-8).
 *
 * The gateway returns geometry: a box plus a base85 mask payload.
 * Decoding uses Meta's official @meta-sam/parser. The mask raster
 * covers the segment's box (placed at x1,y1; wire coordinates are
 * inclusive, so the pixel box is x2-x1+1 by y2-y1+1). Compositing
 * turns a working derivative + raster into the three things a
 * human needs to assess quality: an overlay, a transparent cut-out,
 * and the raw mask.
 */
import { decodeMaskToRaster, type SegmentationMask } from "@meta-sam/parser";
import sharp from "sharp";
import type { SamSegment } from "../gateway/model-gateway";

export class SamMaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamMaskError";
  }
}

export interface DecodedSegment {
  id: string;
  box: { x1: number; y1: number; x2: number; y2: number };
  confidence?: number;
  /** Row-major 0/1 raster at maskWidth x maskHeight, placed at box origin. */
  raster: Uint8Array;
  maskWidth: number;
  maskHeight: number;
  maskPixels: number;
  /** Share of the whole frame covered, 0..1. */
  coverageFrame: number;
  /** Share of the box covered, 0..1. */
  coverageBox: number;
}

export function toSegmentationMask(segment: SamSegment): SegmentationMask {
  const encoding =
    segment.mask.encoding === "~"
      ? "lossless"
      : segment.mask.encoding === "!"
        ? "one_bit"
        : null;
  if (!encoding) {
    throw new SamMaskError(`Unknown SAM mask encoding marker: ${segment.mask.encoding}`);
  }
  return {
    encoding,
    // The parser expects the wire payload including its marker char;
    // our gateway split the marker into `encoding`, so reattach it.
    payload: segment.mask.encoding + segment.mask.payload,
    width: segment.mask.width,
    height: segment.mask.height,
  };
}

export function decodeSegment(
  segment: SamSegment,
  frame: { width: number; height: number },
): DecodedSegment {
  let raster: Uint8Array;
  try {
    raster = decodeMaskToRaster(toSegmentationMask(segment));
  } catch (cause) {
    throw new SamMaskError(
      `SAM mask could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const maskPixels = raster.reduce((sum, v) => sum + (v ? 1 : 0), 0);
  const boxArea = Math.max(
    1,
    (segment.box.x2 - segment.box.x1 + 1) * (segment.box.y2 - segment.box.y1 + 1),
  );
  return {
    id: segment.id,
    box: {
      x1: segment.box.x1,
      y1: segment.box.y1,
      x2: segment.box.x2,
      y2: segment.box.y2,
    },
    ...(segment.box.confidence !== undefined
      ? { confidence: segment.box.confidence }
      : {}),
    raster,
    maskWidth: segment.mask.width,
    maskHeight: segment.mask.height,
    maskPixels,
    coverageFrame: frame.width > 0 && frame.height > 0
      ? maskPixels / (frame.width * frame.height)
      : 0,
    coverageBox: maskPixels / boxArea,
  };
}

/** Sample the box-placed mask at frame pixel (x,y), nearest-neighbour. */
export function maskAt(segment: DecodedSegment, x: number, y: number): boolean {
  const boxW = segment.box.x2 - segment.box.x1 + 1;
  const boxH = segment.box.y2 - segment.box.y1 + 1;
  const dx = x - segment.box.x1;
  const dy = y - segment.box.y1;
  if (dx < 0 || dy < 0 || dx >= boxW || dy >= boxH) return false;
  const mx = Math.min(segment.maskWidth - 1, Math.floor((dx / boxW) * segment.maskWidth));
  const my = Math.min(segment.maskHeight - 1, Math.floor((dy / boxH) * segment.maskHeight));
  return segment.raster[my * segment.maskWidth + mx] === 1;
}

export const SEGMENT_COLORS: readonly (readonly [number, number, number])[] = [
  [255, 59, 48],
  [0, 122, 255],
  [52, 199, 89],
  [255, 149, 0],
  [175, 82, 222],
  [255, 204, 0],
  [0, 199, 190],
  [255, 45, 85],
];

async function toRawRgb(image: Uint8Array): Promise<{
  data: Buffer;
  width: number;
  height: number;
}> {
  const { data, info } = await sharp(Buffer.from(image))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: Buffer.from(data), width: info.width, height: info.height };
}

/** Working image with each mask tinted and its box outlined. */
export async function renderOverlay(
  image: Uint8Array,
  segments: readonly DecodedSegment[],
): Promise<Buffer> {
  const { data, width, height } = await toRawRgb(image);
  const channels = 4;
  segments.forEach((segment, index) => {
    const [r, g, b] = SEGMENT_COLORS[index % SEGMENT_COLORS.length];
    const x2 = Math.min(width - 1, segment.box.x2);
    const y2 = Math.min(height - 1, segment.box.y2);
    for (let y = Math.max(0, segment.box.y1); y <= y2; y++) {
      for (let x = Math.max(0, segment.box.x1); x <= x2; x++) {
        if (!maskAt(segment, x, y)) continue;
        const i = (y * width + x) * channels;
        data[i] = Math.round(data[i] * 0.45 + r * 0.55);
        data[i + 1] = Math.round(data[i + 1] * 0.45 + g * 0.55);
        data[i + 2] = Math.round(data[i + 2] * 0.45 + b * 0.55);
      }
    }
    const border = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const i = (y * width + x) * channels;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    };
    for (let t = 0; t < 3; t++) {
      for (let x = segment.box.x1; x <= segment.box.x2; x++) {
        border(x, segment.box.y1 + t);
        border(x, segment.box.y2 - t);
      }
      for (let y = segment.box.y1; y <= segment.box.y2; y++) {
        border(segment.box.x1 + t, y);
        border(segment.box.x2 - t, y);
      }
    }
  });
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/** Transparent cut-out cropped to the box (alpha = mask). */
export async function renderCutout(
  image: Uint8Array,
  segment: DecodedSegment,
): Promise<Buffer> {
  const { data, width, height } = await toRawRgb(image);
  const channels = 4;
  const x1 = Math.max(0, segment.box.x1);
  const y1 = Math.max(0, segment.box.y1);
  const x2 = Math.min(width - 1, segment.box.x2);
  const y2 = Math.min(height - 1, segment.box.y2);
  const outW = Math.max(1, x2 - x1 + 1);
  const outH = Math.max(1, y2 - y1 + 1);
  const out = Buffer.alloc(outW * outH * channels);
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      const src = (y * width + x) * channels;
      const dst = ((y - y1) * outW + (x - x1)) * channels;
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = maskAt(segment, x, y) ? 255 : 0;
    }
  }
  return sharp(out, { raw: { width: outW, height: outH, channels } }).png().toBuffer();
}

/** The mask alone as a grayscale PNG at mask resolution. */
export async function renderMask(segment: DecodedSegment): Promise<Buffer> {
  const gray = Buffer.alloc(segment.raster.length);
  segment.raster.forEach((v, i) => {
    gray[i] = v ? 255 : 0;
  });
  return sharp(gray, {
    raw: { width: segment.maskWidth, height: segment.maskHeight, channels: 1 },
  })
    .png()
    .toBuffer();
}
