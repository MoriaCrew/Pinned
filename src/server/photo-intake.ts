import "server-only";
/**
 * Photo intake (PIN-34 / PIN-7B).
 *
 * Player photos are never persisted as uploaded. This module turns
 * raw request bytes into one bounded working derivative:
 * magic-byte type sniffing (never the client MIME header), a pixel
 * budget against decompression bombs, decode + auto-rotate +
 * resize + re-encode through sharp, and full metadata (EXIF/XMP/
 * ICC) removal as a consequence of re-encoding without metadata.
 * Callers store only the returned derivative.
 */
import sharp from "sharp";
import { englishText, userMessage, type UserMessage } from "../i18n/user-message";

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_WORKING_DIMENSION = 1600;
export const MAX_INPUT_PIXELS = 40_000_000;
export const WORKING_IMAGE_CONTENT_TYPE = "image/webp";

export type PhotoKind = "jpeg" | "png" | "webp";

export type PhotoIntakeErrorCode =
  | "empty"
  | "too_large"
  | "unsupported_type"
  | "decode_failed";

export class PhotoIntakeError extends Error {
  readonly userMessage?: UserMessage;

  constructor(
    message: UserMessage | string,
    public readonly code: PhotoIntakeErrorCode,
    public readonly status: 400 | 413 | 415 = 400,
  ) {
    super(englishText(message));
    this.name = "PhotoIntakeError";
    this.userMessage = typeof message === "string" ? undefined : message;
  }
}

export interface ProcessedPhoto {
  /** Re-encoded working derivative (WebP, metadata-free). */
  derivative: Buffer;
  contentType: typeof WORKING_IMAGE_CONTENT_TYPE;
  sourceKind: PhotoKind;
  sourceBytes: number;
  width: number;
  height: number;
}

export interface PhotoIntakeOptions {
  maxBytes?: number;
  maxDimension?: number;
  maxInputPixels?: number;
}

/** Sniff the real image kind from magic bytes; null when unsupported. */
export function detectPhotoKind(bytes: Uint8Array): PhotoKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 && // P
    bytes[2] === 0x4e && // N
    bytes[3] === 0x47 && // G
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "webp";
  }
  return null;
}

export async function processPhoto(
  bytes: Uint8Array,
  options: PhotoIntakeOptions = {},
): Promise<ProcessedPhoto> {
  const maxBytes = options.maxBytes ?? MAX_PHOTO_BYTES;
  const maxDimension = options.maxDimension ?? MAX_WORKING_DIMENSION;
  const maxInputPixels = options.maxInputPixels ?? MAX_INPUT_PIXELS;

  if (!bytes || bytes.length === 0) {
    throw new PhotoIntakeError(userMessage("error.photoEmpty"), "empty");
  }
  if (bytes.length > maxBytes) {
    throw new PhotoIntakeError(
      userMessage("error.photoTooLarge", { mb: Math.round(maxBytes / (1024 * 1024)) }),
      "too_large",
      413,
    );
  }
  const sourceKind = detectPhotoKind(bytes);
  if (!sourceKind) {
    throw new PhotoIntakeError(
      userMessage("error.photoType"),
      "unsupported_type",
      415,
    );
  }

  let derivative: Buffer;
  let width: number;
  let height: number;
  try {
    const pipeline = sharp(Buffer.from(bytes), {
      failOn: "error",
      limitInputPixels: maxInputPixels,
      sequentialRead: true,
    })
      .rotate()
      .resize({
        width: maxDimension,
        height: maxDimension,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82 });
    const result = await pipeline.toBuffer({ resolveWithObject: true });
    derivative = result.data;
    width = result.info.width;
    height = result.info.height;
  } catch {
    throw new PhotoIntakeError(
      userMessage("error.photoUnreadable"),
      "decode_failed",
    );
  }

  // Defence in depth: the derivative must itself be a clean WebP with
  // no metadata blocks before any caller is allowed to store it.
  let clean = false;
  try {
    const meta = await sharp(derivative).metadata();
    clean =
      meta.format === "webp" && !meta.exif && !meta.xmp && !meta.icc && !meta.iptc;
  } catch {
    clean = false;
  }
  if (!clean) {
    throw new PhotoIntakeError(
      userMessage("error.photoUnsafe"),
      "decode_failed",
    );
  }

  return {
    derivative,
    contentType: WORKING_IMAGE_CONTENT_TYPE,
    sourceKind,
    sourceBytes: bytes.length,
    width,
    height,
  };
}
