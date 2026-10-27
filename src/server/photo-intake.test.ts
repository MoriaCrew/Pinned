import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  MAX_PHOTO_BYTES,
  PhotoIntakeError,
  detectPhotoKind,
  processPhoto,
} from "./photo-intake";
import {
  InMemoryDerivativeStore,
  assertDerivativeRef,
  buildWorkingImageRef,
} from "./derivative-store";

async function makeImage(
  format: "jpeg" | "png" | "webp",
  width = 64,
  height = 48,
): Promise<Buffer> {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 32, g: 64, b: 96 } },
  });
  if (format === "jpeg") return base.jpeg().toBuffer();
  if (format === "png") return base.png().toBuffer();
  return base.webp().toBuffer();
}

describe("detectPhotoKind (magic bytes, not client MIME)", () => {
  it("recognises jpeg/png/webp and rejects gif/text/empty", async () => {
    expect(detectPhotoKind(await makeImage("jpeg"))).toBe("jpeg");
    expect(detectPhotoKind(await makeImage("png"))).toBe("png");
    expect(detectPhotoKind(await makeImage("webp"))).toBe("webp");
    expect(detectPhotoKind(Buffer.from("GIF89a"))).toBeNull();
    expect(detectPhotoKind(Buffer.from("not an image at all"))).toBeNull();
    expect(detectPhotoKind(Buffer.alloc(0))).toBeNull();
  });
});

describe("processPhoto", () => {
  it("re-encodes a JPEG with EXIF into a metadata-free WebP derivative", async () => {
    const plain = await makeImage("jpeg", 120, 90);
    const withExif = await sharp(plain)
      .withExif({ IFD0: { Copyright: "Pinned EXIF probe", Software: "test-suite" } })
      .jpeg()
      .toBuffer();
    const inputMeta = await sharp(withExif).metadata();
    expect(inputMeta.exif).toBeTruthy();

    const result = await processPhoto(withExif);
    expect(result.contentType).toBe("image/webp");
    expect(result.sourceKind).toBe("jpeg");
    expect(result.width).toBe(120);
    expect(result.height).toBe(90);

    const outputMeta = await sharp(result.derivative).metadata();
    expect(outputMeta.format).toBe("webp");
    expect(outputMeta.exif).toBeFalsy();
    expect(outputMeta.xmp).toBeFalsy();
    expect(outputMeta.icc).toBeFalsy();
    expect(result.derivative.includes(Buffer.from("Pinned EXIF probe"))).toBe(false);
  });

  it("bounds oversized dimensions to the working size", async () => {
    const big = await makeImage("png", 3200, 1600);
    const result = await processPhoto(big);
    expect(result.width).toBe(1600);
    expect(result.height).toBe(800);
  });

  it("rejects empty, oversize, unsupported, and truncated inputs safely", async () => {
    await expect(processPhoto(Buffer.alloc(0))).rejects.toMatchObject({
      code: "empty",
    });

    const oversize = Buffer.alloc(MAX_PHOTO_BYTES + 1, 0);
    oversize[0] = 0xff;
    oversize[1] = 0xd8;
    oversize[2] = 0xff;
    await expect(processPhoto(oversize)).rejects.toBeInstanceOf(PhotoIntakeError);
    await expect(processPhoto(oversize)).rejects.toMatchObject({
      code: "too_large",
      status: 413,
    });

    await expect(processPhoto(Buffer.from("GIF89a-not-supported"))).rejects.toMatchObject({
      code: "unsupported_type",
      status: 415,
    });

    const jpeg = await makeImage("jpeg");
    const truncated = jpeg.subarray(0, 24);
    await expect(processPhoto(truncated)).rejects.toMatchObject({
      code: "decode_failed",
    });
  });

  it("enforces the pixel budget against decompression bombs", async () => {
    const image = await makeImage("png", 400, 300); // 120k pixels
    await expect(processPhoto(image, { maxInputPixels: 10_000 })).rejects.toMatchObject({
      code: "decode_failed",
    });
  });
});

describe("derivative refs and in-memory store", () => {
  it("builds tmp-prefixed refs and rejects path traversal", () => {
    expect(buildWorkingImageRef("game1", "player1", "sub1")).toBe(
      "tmp/games/game1/players/player1/submissions/sub1/working.webp",
    );
    expect(() => assertDerivativeRef("../escape")).toThrow();
    expect(() => assertDerivativeRef("/absolute")).toThrow();
    expect(() => assertDerivativeRef("a//b")).toThrow();
    expect(() => buildWorkingImageRef("../x", "p", "s")).toThrow();
  });

  it("round-trips and deletes derivatives", async () => {
    const store = new InMemoryDerivativeStore();
    const ref = buildWorkingImageRef("g", "p", "s");
    await store.put(ref, Buffer.from("webp-bytes"), "image/webp");
    expect((await store.get(ref))?.toString()).toBe("webp-bytes");
    await store.delete(ref);
    expect(await store.get(ref)).toBeNull();
  });
});
