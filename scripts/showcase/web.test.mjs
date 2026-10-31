import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { IPTC_AI_SOURCE, SET_BUDGET_BYTES, XMP_PACKET, buildCutout, buildSquare, buildWeb, metadataProblems, squareExtract, validateWebSpec, webFileName, webParams } from "./web.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "showcase-web-"));

/** A noisy RGB picture, so a WebP of it is not tiny. */
async function makePicture(file, width, height, { alpha = false } = {}) {
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 31 + (i >> 3)) & 255;
  await sharp(raw, { raw: { width, height, channels } }).png().toFile(file);
}

describe("the XMP packet", () => {
  it("holds the IPTC marker and nothing else", () => {
    expect(XMP_PACKET).toContain(`<Iptc4xmpExt:DigitalSourceType>${IPTC_AI_SOURCE}</Iptc4xmpExt:DigitalSourceType>`);
    expect(IPTC_AI_SOURCE).toBe("http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia");
    const elements = [...XMP_PACKET.matchAll(/<([A-Za-z][\w-]*:[\w-]+)/g)].map((m) => m[1]);
    expect(new Set(elements)).toEqual(new Set(["x:xmpmeta", "rdf:RDF", "rdf:Description", "Iptc4xmpExt:DigitalSourceType"]));
    expect(XMP_PACKET.startsWith('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>')).toBe(true);
    expect(XMP_PACKET.endsWith('<?xpacket end="r"?>')).toBe(true);
  });

  it("is what landing-sets.test.ts expects of every shipped picture", () => {
    const test = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/app/landing-sets.test.ts"), "utf8");
    expect(test).toContain(IPTC_AI_SOURCE);
    for (const name of ["x:xmpmeta", "rdf:RDF", "rdf:Description", "Iptc4xmpExt:DigitalSourceType"]) expect(test).toContain(`"${name}"`);
    expect(test).toContain(`${SET_BUDGET_BYTES / 1024} * 1024`);
  });
});

describe("build parameters", () => {
  it("follow docs/17 step 6", () => {
    expect(webParams()).toEqual({
      cutout: { width: 360, height: 640, webp: { quality: 78, alphaQuality: 90, effort: 6 } },
      photo: { px: 560, webp: { quality: 72, effort: 6 } },
      scene: { px: 600, webp: { quality: 72, effort: 6 } },
    });
  });

  it("takes a quality, squares 6 lower, and refuses a silly one", () => {
    const params = webParams(70);
    expect(params.cutout.webp.quality).toBe(70);
    expect(params.photo.webp.quality).toBe(64);
    expect(() => webParams(20)).toThrow(RangeError);
    expect(() => webParams(78.5)).toThrow(RangeError);
  });
});

describe("squareExtract", () => {
  it("cuts the shorter side from a landscape or portrait picture", () => {
    expect(squareExtract(1920, 1280, { left: 0.14, top: 0 })).toEqual({ left: 269, top: 0, width: 1280, height: 1280 });
    expect(squareExtract(1280, 1920, { left: 0, top: 0.1 })).toEqual({ left: 0, top: 192, width: 1280, height: 1280 });
  });

  it("keeps the square inside the picture", () => {
    expect(squareExtract(1920, 1280, { left: 0.9, top: 0.9 })).toEqual({ left: 640, top: 0, width: 1280, height: 1280 });
    expect(squareExtract(1280, 1920, { left: -1, top: 1 })).toEqual({ left: 0, top: 640, width: 1280, height: 1280 });
  });
});

describe("building files with sharp", () => {
  it("makes a cut-out that fits the box, is never enlarged, keeps alpha and carries only the marker", async () => {
    const dir = tmp();
    await makePicture(path.join(dir, "big.png"), 1000, 1400, { alpha: true });
    await makePicture(path.join(dir, "small.png"), 100, 150, { alpha: true });
    const { cutout } = webParams();
    await buildCutout(path.join(dir, "big.png"), path.join(dir, "big.webp"), cutout);
    await buildCutout(path.join(dir, "small.png"), path.join(dir, "small.webp"), cutout);

    const big = await sharp(path.join(dir, "big.webp")).metadata();
    expect([big.format, big.width, big.height, big.hasAlpha]).toEqual(["webp", 360, 504, true]);
    const small = await sharp(path.join(dir, "small.webp")).metadata();
    expect([small.width, small.height]).toEqual([100, 150]);
    expect(metadataProblems(big)).toEqual([]);
    expect(metadataProblems(small)).toEqual([]);
  });

  it("makes a square crop at the asked size with only the marker", async () => {
    const dir = tmp();
    await makePicture(path.join(dir, "wide.png"), 1920, 1280);
    await buildSquare(path.join(dir, "wide.png"), path.join(dir, "photo.webp"), { left: 0.14, top: 0 }, webParams().photo);
    const meta = await sharp(path.join(dir, "photo.webp")).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 560, 560]);
    expect(metadataProblems(meta)).toEqual([]);
  });

  it("drops the EXIF of its input", async () => {
    const dir = tmp();
    await sharp({ create: { width: 64, height: 64, channels: 3, background: "#c33" } }).withExif({ IFD0: { Copyright: "someone" } }).png().toFile(path.join(dir, "exif.png"));
    await buildSquare(path.join(dir, "exif.png"), path.join(dir, "out.webp"), {}, webParams().scene);
    expect(metadataProblems(await sharp(path.join(dir, "out.webp")).metadata())).toEqual([]);
  });
});

describe("metadataProblems", () => {
  it("names EXIF, a missing marker and other XMP", () => {
    expect(metadataProblems({ exif: Buffer.from("x") })).toEqual(["has EXIF", "lacks the AI-generated marker"]);
    const extra = XMP_PACKET.replace("</rdf:Description>", "<dc:creator>someone</dc:creator></rdf:Description>");
    expect(metadataProblems({ xmp: Buffer.from(extra) })).toEqual(["has other XMP (dc:creator)"]);
  });
});

describe("web spec", () => {
  const spec = {
    set: "cat",
    items: [
      { type: "cutout", id: "ginger-cat", friend: "Aye", match: "cat|tabby" },
      { type: "photo", name: "photo-shelf", friend: "Ben", left: 0.14, top: 0 },
      { type: "scene", name: "scene-street", scene: "c1-street", left: 0, top: 0.1 },
    ],
  };

  it("accepts the three kinds of item and names their files", () => {
    expect(validateWebSpec(spec)).toEqual([]);
    expect(spec.items.map(webFileName)).toEqual(["cutout-ginger-cat.webp", "photo-shelf.webp", "scene-street.webp"]);
  });

  it("rejects what cannot be built", () => {
    const bad = { set: "cat", items: [{ type: "cutout", id: "A B", friend: "Aye", match: "(" }, { type: "photo", name: "p", left: 2 }, { type: "movie" }, { type: "photo", name: "p", friend: "Ben" }] };
    const errors = validateWebSpec(bad);
    expect(errors.join("\n")).toMatch(/items\[0\]: id must be lowercase/);
    expect(errors.join("\n")).toMatch(/items\[0\]: match Invalid regular expression/);
    expect(errors.join("\n")).toMatch(/items\[1\]: friend is required/);
    expect(errors.join("\n")).toMatch(/items\[1\]: left and top are fractions/);
    expect(errors.join("\n")).toMatch(/items\[2\]: type must be/);
    expect(errors.join("\n")).toMatch(/items\[3\]: "p" is built twice/);
    expect(validateWebSpec({})).toEqual(["a web spec needs a set id and a list of items"]);
  });
});

describe("buildWeb", () => {
  it("builds each item from the run record, and reports what it cannot find", async () => {
    const outDir = tmp();
    const destDir = path.join(tmp(), "cat");
    await makePicture(path.join(outDir, "aye-0-ginger-cat-cutout.png"), 400, 800, { alpha: true });
    mkdirSync(path.join(outDir, "photos"));
    await makePicture(path.join(outDir, "photos", "ben.png"), 1920, 1280);
    await makePicture(path.join(outDir, "scene-c1-street.png"), 1280, 1920);
    const run = {
      friends: [
        { name: "Aye", photoFile: "photos/aye.png", elements: [{ label: "Ginger Tabby Cat", description: "", files: { cutout: "aye-0-ginger-cat-cutout.png" } }] },
        { name: "Ben", photoFile: "photos/ben.png", elements: [] },
      ],
      scenes: [{ id: "c1-street", file: "scene-c1-street.png" }],
    };
    const spec = {
      set: "cat",
      items: [
        { type: "cutout", id: "ginger-cat", friend: "Aye", match: "cat|tabby" },
        { type: "cutout", id: "beanie", friend: "Ben", match: "beanie" },
        { type: "photo", name: "photo-shelf", friend: "Ben", left: 0.14, top: 0 },
        { type: "scene", name: "scene-street", scene: "c1-street", top: 0.1 },
      ],
    };
    const result = await buildWeb(spec, run, { outDir, destDir });
    expect(result.written.map((f) => path.basename(f))).toEqual(["cutout-ginger-cat.webp", "photo-shelf.webp", "scene-street.webp"]);
    expect(result.problems).toEqual(["cutout-beanie.webp: no source in the run record"]);
    expect(result.folderBytes).toBe(result.written.reduce((sum, f) => sum + statSync(f).size, 0));
  });

  it("refuses a run record that points out of its folder", async () => {
    const outDir = tmp();
    const outside = tmp();
    await makePicture(path.join(outside, "secret.png"), 64, 64);
    const run = { friends: [{ name: "Aye", photoFile: path.relative(outDir, path.join(outside, "secret.png")), elements: [] }], scenes: [] };
    const result = await buildWeb({ set: "x", items: [{ type: "photo", name: "p", friend: "Aye" }] }, run, { outDir, destDir: path.join(tmp(), "x") });
    expect(result.written).toEqual([]);
    expect(result.problems).toEqual(["p.webp: no source in the run record"]);
  });

  it("flags a set over the weight budget", async () => {
    const outDir = tmp();
    const destDir = tmp();
    writeFileSync(path.join(destDir, "old.webp"), Buffer.alloc(SET_BUDGET_BYTES + 1));
    await makePicture(path.join(outDir, "a.png"), 64, 64);
    const run = { friends: [{ name: "Aye", photoFile: "a.png", elements: [] }], scenes: [] };
    const result = await buildWeb({ set: "x", items: [{ type: "photo", name: "p", friend: "Aye" }] }, run, { outDir, destDir });
    expect(result.problems).toEqual([expect.stringMatching(/the set weighs .* KB, over the 220 KB budget/)]);
  });
});
