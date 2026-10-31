import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { composeCollage } from "./scene-collage";

/** Solid-colour cut-out stand-in (synthetic, no fixture files). */
async function swatch(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 30, channels: 4, background: { r, g, b, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

describe("composeCollage (PIN-71): N cut-outs -> 1 image, no network", () => {
  const size = { width: 200, height: 300 };

  it("composites 1, 2, 3 and 4 cut-outs onto one PNG at canvas size", async () => {
    const cuts = [
      await swatch(230, 40, 40),
      await swatch(40, 200, 60),
      await swatch(40, 60, 230),
      await swatch(240, 210, 30),
    ];
    for (const n of [1, 2, 3, 4]) {
      const out = await composeCollage(cuts.slice(0, n), size);
      const meta = await sharp(out).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBe(size.width);
      expect(meta.height).toBe(size.height);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it("every cut-out's colour lands in the composite (not a blank gradient)", async () => {
    const red = await swatch(230, 40, 40);
    const blue = await swatch(40, 60, 230);
    const out = await composeCollage([red, blue], size);
    const { data, info } = await sharp(out)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const near = (r: number, g: number, b: number) => {
      for (let i = 0; i < data.length; i += info.channels) {
        if (
          Math.abs(data[i] - r) <= 8
          && Math.abs(data[i + 1] - g) <= 8
          && Math.abs(data[i + 2] - b) <= 8
        ) {
          return true;
        }
      }
      return false;
    };
    expect(near(230, 40, 40)).toBe(true);
    expect(near(40, 60, 230)).toBe(true);
  });

  it("remix (PIN-79): cut-outs composite OVER the parent image, not the gradient", async () => {
    const parent = await swatch(20, 20, 20); // near-black parent
    const red = await swatch(230, 40, 40);
    const out = await composeCollage([red], size, parent);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([size.width, size.height]);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    // Corner pixel: parent colour (the gradient corner is pale #f7e8c9).
    const [r, g, b] = at(2, 2);
    expect(r).toBeLessThan(60);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
    // The new cut-out still lands somewhere in frame.
    let redFound = false;
    for (let i = 0; i < data.length; i += info.channels) {
      if (Math.abs(data[i] - 230) <= 8 && Math.abs(data[i + 1] - 40) <= 8) redFound = true;
    }
    expect(redFound).toBe(true);
  });

  it("rejects zero cut-outs and undecodable input instead of a fake image", async () => {
    await expect(composeCollage([], size)).rejects.toThrow(RangeError);
    await expect(composeCollage([Buffer.from("not an image")], size)).rejects.toThrow();
  });
});
