import "server-only";
/**
 * Mock collage composer (PIN-71, PIN-54 Slice 2 closer; docs/11
 * section 5.6 "mock collage"). The offline / over-budget fallback:
 * elements' transparent cut-outs composited with sharp onto a
 * colour gradient — no model call, no network, $0. Scenes made
 * here are recorded with kind "collage" (domain/board.ts), never
 * presented as an AI scene.
 *
 * Canvas size comes from Policy.sceneSize (parsed by
 * parseSceneSize) so a collage fills the same gallery frame as an
 * AI scene; only layout fractions live here.
 */
import sharp, { type OverlayOptions } from "sharp";

export interface CollageSize {
  width: number;
  height: number;
}

const SCENE_SIZE = /^(\d+)x(\d+)$/;

/** Policy.sceneSize ("1024x1536") -> canvas dims, or null. */
export function parseSceneSize(size: string): CollageSize | null {
  const match = SCENE_SIZE.exec(size.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Fraction of the shorter canvas edge kept as outer padding / gaps. */
const PAD_FRACTION = 0.06;

function gradientSvg({ width, height }: CollageSize): Buffer {
  // Warm paper-to-blush diagonal: reads as a backdrop, not an error.
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
      + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
      + `<stop offset="0" stop-color="#f7e8c9"/>`
      + `<stop offset="0.55" stop-color="#f3c6a5"/>`
      + `<stop offset="1" stop-color="#d98cb3"/>`
      + `</linearGradient></defs>`
      + `<rect width="${width}" height="${height}" fill="url(#g)"/>`
      + `</svg>`,
  );
}

/**
 * Composite N cut-out PNGs onto the gradient in a centred grid
 * (1 -> single, 2 -> stacked, 3-4 -> 2x2, generic beyond). Every
 * cut-out is scaled to fit its cell with its aspect preserved.
 * Returns one PNG at exactly `size`. Throws RangeError with no
 * cut-outs; sharp errors on undecodable input propagate so the
 * caller can land the job as failed (typed, never a 500).
 */
/**
 * With `backgroundBytes` (PIN-79 remix fallback, §5.7) the
 * cut-outs composite OVER that image — the parent scene,
 * cover-fitted to the canvas — instead of the gradient. The
 * Scene is still recorded kind "collage", honestly labelled.
 */
export async function composeCollage(
  cutouts: Buffer[],
  size: CollageSize,
  backgroundBytes?: Buffer,
): Promise<Buffer> {
  if (cutouts.length === 0) {
    throw new RangeError("A collage needs at least one cut-out.");
  }
  if (!(size.width > 0 && size.height > 0)) {
    throw new RangeError("Collage canvas must be positive.");
  }
  const pad = Math.max(1, Math.round(Math.min(size.width, size.height) * PAD_FRACTION));
  const cols = cutouts.length === 1 ? 1 : Math.ceil(Math.sqrt(cutouts.length));
  const rows = Math.ceil(cutouts.length / cols);
  const cellWidth = Math.floor((size.width - pad * (cols + 1)) / cols);
  const cellHeight = Math.floor((size.height - pad * (rows + 1)) / rows);
  if (cellWidth < 1 || cellHeight < 1) {
    throw new RangeError("Collage canvas is too small for its cut-outs.");
  }

  const composites: OverlayOptions[] = [];
  for (let i = 0; i < cutouts.length; i += 1) {
    const fitted = await sharp(cutouts[i])
      .resize(cellWidth, cellHeight, { fit: "inside" })
      .png()
      .toBuffer({ resolveWithObject: true });
    const col = i % cols;
    const row = Math.floor(i / cols);
    // Centre the fitted cut-out in its cell; a short final row is
    // centred as a row so 3 cut-outs read as a triangle, not a gap.
    const inRow = Math.min(cols, cutouts.length - row * cols);
    const rowOffset = Math.floor(
      ((cols - inRow) * (cellWidth + pad)) / 2,
    );
    composites.push({
      input: fitted.data,
      left: pad + rowOffset + col * (cellWidth + pad)
        + Math.floor((cellWidth - fitted.info.width) / 2),
      top: pad + row * (cellHeight + pad)
        + Math.floor((cellHeight - fitted.info.height) / 2),
    });
  }

  const background = backgroundBytes
    ? await sharp(backgroundBytes)
        .resize(size.width, size.height, { fit: "cover" })
        .png()
        .toBuffer()
    : await sharp(gradientSvg(size)).png().toBuffer();
  return sharp(background).composite(composites).png().toBuffer();
}
