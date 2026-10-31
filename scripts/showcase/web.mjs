/**
 * Build the web files of a showcase set (PIN-173, docs/17 step 6):
 * resized WebPs that carry one XMP field, the IPTC "made by a trained
 * model" marker, and no other metadata. `sharp` is loaded on use, so
 * the pure parts (packet, parameters, crop maths, checks) need no
 * native module.
 */
import { mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { compileMatch } from "./spec.mjs";

export const IPTC_AI_SOURCE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

/** The one XMP packet a shipped picture carries (docs/17 step 6). */
export const XMP_PACKET = [
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
  '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
  '<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">',
  `<Iptc4xmpExt:DigitalSourceType>${IPTC_AI_SOURCE}</Iptc4xmpExt:DigitalSourceType>`,
  "</rdf:Description>",
  "</rdf:RDF>",
  "</x:xmpmeta>",
  '<?xpacket end="r"?>',
].join("");

/** The only XMP elements a landing picture may carry (src/app/landing-sets.test.ts keeps the same list). */
const XMP_ALLOWED = new Set(["x:xmpmeta", "rdf:RDF", "rdf:Description", "Iptc4xmpExt:DigitalSourceType"]);

/** What `src/app/landing-sets.test.ts` allows one set to weigh. */
export const SET_BUDGET_BYTES = 220 * 1024;

export const DEFAULT_QUALITY = 78;

/**
 * Build parameters for a cut-out (fit inside 360x640, never enlarged: about twice
 * the largest pile slot on a phone), a photo (560 px square) and a scene (600 px square).
 * Squares use `quality - 6`, as the first two sets did.
 */
export function webParams(quality = DEFAULT_QUALITY) {
  if (!Number.isInteger(quality) || quality < 40 || quality > 95) throw new RangeError("quality must be a whole number from 40 to 95");
  return {
    cutout: { width: 360, height: 640, webp: { quality, alphaQuality: 90, effort: 6 } },
    photo: { px: 560, webp: { quality: quality - 6, effort: 6 } },
    scene: { px: 600, webp: { quality: quality - 6, effort: 6 } },
  };
}

/** The square to cut from a picture: `left` and `top` are fractions of its width and height, kept inside the frame. */
export function squareExtract(width, height, { left = 0, top = 0 } = {}) {
  const side = Math.min(width, height);
  const clamp = (value, max) => Math.min(Math.max(Math.round(value), 0), max);
  return { left: clamp(left * width, width - side), top: clamp(top * height, height - side), width: side, height: side };
}

/** Problems with a built file's metadata: any EXIF, or any XMP but the marker packet. Empty means clean. */
export function metadataProblems(meta) {
  const problems = [];
  if (meta.exif) problems.push("has EXIF");
  if (meta.iptc) problems.push("has an IPTC block");
  const xmp = meta.xmp?.toString("utf8") ?? "";
  if (!xmp.includes(`<Iptc4xmpExt:DigitalSourceType>${IPTC_AI_SOURCE}</Iptc4xmpExt:DigitalSourceType>`)) problems.push("lacks the AI-generated marker");
  const stray = [...xmp.matchAll(/<([A-Za-z][\w-]*:[\w-]+)/g)].map((m) => m[1]).filter((name) => !XMP_ALLOWED.has(name));
  if (stray.length) problems.push(`has other XMP (${[...new Set(stray)].join(", ")})`);
  return problems;
}

async function loadSharp() {
  return (await import("sharp")).default;
}

/** Cut-out: the app's SAM cut-out (PNG with alpha) fit inside the box, as WebP with alpha. */
export async function buildCutout(src, dest, params) {
  const sharp = await loadSharp();
  await sharp(src)
    .resize({ width: params.width, height: params.height, fit: "inside", withoutEnlargement: true })
    .webp(params.webp)
    .withXmp(XMP_PACKET)
    .toFile(dest);
}

/** Square crop of a photo or scene at `px`, as WebP. */
export async function buildSquare(src, dest, box, params) {
  const sharp = await loadSharp();
  const { width, height } = await sharp(src).metadata();
  await sharp(src).extract(squareExtract(width, height, box)).resize(params.px).webp(params.webp).withXmp(XMP_PACKET).toFile(dest);
}

/** True when `child` is inside `parent` (a run record must not point a build outside its folder). */
const isInside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

const FRACTION = (v) => v === undefined || (typeof v === "number" && v >= 0 && v <= 1);

/**
 * Check a web spec:
 *   { "set": "cat", "items": [
 *     { "type": "cutout", "id": "ginger-cat", "friend": "Aye", "match": "cat|tabby" },
 *     { "type": "photo", "name": "photo-shelf-beanie-glasses", "friend": "Ben", "left": 0.14, "top": 0 },
 *     { "type": "scene", "name": "scene-street-skate", "scene": "c1-street", "left": 0, "top": 0.1 } ] }
 * Returns the problems found; an empty list means the spec is fine.
 */
export function validateWebSpec(spec) {
  const errors = [];
  if (typeof spec !== "object" || spec === null || typeof spec.set !== "string" || !Array.isArray(spec.items) || spec.items.length === 0) {
    return ["a web spec needs a set id and a list of items"];
  }
  const files = new Set();
  spec.items.forEach((item, i) => {
    const at = `items[${i}]`;
    const stem = item?.type === "cutout" ? `cutout-${item.id}` : item?.name;
    if (!["cutout", "photo", "scene"].includes(item?.type)) return errors.push(`${at}: type must be cutout, photo or scene`);
    if (typeof stem !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(stem.replace(/^cutout-/, ""))) errors.push(`${at}: ${item.type === "cutout" ? "id" : "name"} must be lowercase letters, digits and dashes`);
    if (files.has(stem)) errors.push(`${at}: "${stem}" is built twice`);
    files.add(stem);
    if (typeof item.friend !== "string" && item.type !== "scene") errors.push(`${at}: friend is required`);
    if (item.type === "cutout") {
      try {
        compileMatch(item.match);
      } catch (e) {
        errors.push(`${at}: match ${e.message}`);
      }
    }
    if (item.type === "scene" && typeof item.scene !== "string") errors.push(`${at}: scene is required`);
    if (!FRACTION(item.left) || !FRACTION(item.top)) errors.push(`${at}: left and top are fractions from 0 to 1`);
  });
  return errors;
}

/** Output file name of a web item. */
export const webFileName = (item) => `${item.type === "cutout" ? `cutout-${item.id}` : item.name}.webp`;

/**
 * Build every item of a web spec from a set's run record. `outDir` is the set's work output folder
 * (run.json and the downloads), `destDir` the set's web folder. Returns what was written and any problems.
 */
export async function buildWeb(spec, run, { outDir, destDir, quality }) {
  const params = webParams(quality);
  mkdirSync(destDir, { recursive: true });
  const written = [];
  const problems = [];
  const file = (name) => path.join(outDir, name);
  for (const item of spec.items) {
    const dest = path.join(destDir, webFileName(item));
    let src = null;
    if (item.type === "cutout") {
      const re = compileMatch(item.match);
      const element = run.friends.find((f) => f.name === item.friend)?.elements.find((e) => re.test(e.label) || re.test(e.description ?? ""));
      src = element?.files.cutout;
    } else if (item.type === "photo") {
      src = run.friends.find((f) => f.name === item.friend)?.photoFile;
    } else {
      src = run.scenes.find((s) => s.id === item.scene)?.file;
    }
    if (!src || !isInside(outDir, file(src))) {
      problems.push(`${webFileName(item)}: no source in the run record`);
      continue;
    }
    if (item.type === "cutout") await buildCutout(file(src), dest, params.cutout);
    else await buildSquare(file(src), dest, item, params[item.type]);
    written.push(dest);
    const built = metadataProblems(await (await loadSharp())(dest).metadata());
    if (built.length) problems.push(`${webFileName(item)}: ${built.join(", ")}`);
  }
  const folderBytes = readdirSync(destDir)
    .filter((n) => n.endsWith(".webp"))
    .reduce((sum, n) => sum + statSync(path.join(destDir, n)).size, 0);
  if (folderBytes > SET_BUDGET_BYTES) problems.push(`the set weighs ${(folderBytes / 1024).toFixed(1)} KB, over the ${SET_BUDGET_BYTES / 1024} KB budget`);
  return { written, folderBytes, problems };
}
