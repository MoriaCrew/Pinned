import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { LANDING_SET_ID, type LandingSet } from "../domain/landing-sets";
import en from "../i18n/messages/en.json";
import { LANDING_SETS, landingSetById } from "./landing-sets.data";

// The manifest: the data in landing-sets.data.ts must match the files
// under public/landing/sets/<id>/ (PIN-175). A typo in a path would
// otherwise only show as a broken picture on the landing.

const PUBLIC = path.join(process.cwd(), "public");
/** Per-set weight of the files it references (the landing loads one set per visit). */
const SET_BUDGET_BYTES = 220 * 1024;
/**
 * Longest tag text on the step-1 photo. The art box is 124 px wide on a
 * phone; a 16-letter tag ("Tortoise glasses") ran onto the step text.
 */
const CHIP_MAX_CHARS = 13;
/** The IPTC "made by a trained model" marker (PIN-171: keep it on Muse Image output). */
const AI_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
/** The only XMP elements a landing picture may carry: the packet around that one marker. */
const XMP_ALLOWED = new Set(["x:xmpmeta", "rdf:RDF", "rdf:Description", "Iptc4xmpExt:DigitalSourceType"]);
/** Sets made before PIN-171 carry no marker; re-encoding them would change their pixels. */
const UNMARKED_SETS = new Set(["classic"]);

const fileOf = (src: string) => path.join(PUBLIC, ...src.split("/"));

/** Every file a set points at, once each. */
function referencedFiles(set: LandingSet): string[] {
  const srcs = [...Object.values(set.stickers).map((sticker) => sticker.src), set.photo.src, set.scene.src];
  return [...new Set(srcs)];
}

describe("landing set manifest (PIN-175)", () => {
  it("has at least two sets with unique, url-safe ids", () => {
    const ids = LANDING_SETS.map((set) => set.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(LANDING_SET_ID.test(id), id).toBe(true);
  });

  it("falls back to a real set for an id it does not know", () => {
    expect(landingSetById("nope")).toBe(LANDING_SETS[0]);
    for (const set of LANDING_SETS) expect(landingSetById(set.id)).toBe(set);
  });

  for (const set of LANDING_SETS) {
    describe(`set "${set.id}"`, () => {
      it("keeps every file under its own folder, and every referenced file exists", () => {
        for (const file of referencedFiles(set)) {
          expect(file.startsWith(`/landing/sets/${set.id}/`), file).toBe(true);
          expect(file.endsWith(".webp"), file).toBe(true);
          expect(existsSync(fileOf(file)), file).toBe(true);
        }
      });

      it("leaves no file in its folder unused", () => {
        const used = new Set(referencedFiles(set).map((file) => path.basename(file)));
        const inFolder = readdirSync(path.join(PUBLIC, "landing", "sets", set.id));
        expect(inFolder.filter((name) => !used.has(name))).toEqual([]);
      });

      it("shows 5 to 7 distinct stickers in the pile, all defined", () => {
        expect(set.pile.length).toBeGreaterThanOrEqual(5);
        expect(set.pile.length).toBeLessThanOrEqual(7);
        const ids = set.pile.map((slot) => slot.sticker);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(set.stickers[id], id).toBeDefined();
      });

      it("shows 3 distinct stickers in step 2, from at least two friends", () => {
        expect(set.trio).toHaveLength(3);
        const ids = set.trio.map((slot) => slot.sticker);
        expect(new Set(ids).size).toBe(3);
        for (const id of ids) expect(set.stickers[id], id).toBeDefined();
        const owners = new Set(ids.map((id) => set.stickers[id]?.owner));
        expect(owners.size).toBeGreaterThanOrEqual(2);
      });

      it("uses a stickers entry only if the pile or step 2 shows it", () => {
        const shown = new Set([...set.pile, ...set.trio].map((slot) => slot.sticker));
        expect(Object.keys(set.stickers).filter((id) => !shown.has(id))).toEqual([]);
      });

      it("keeps positions, sizes and tilts in a sane range", () => {
        for (const slot of set.pile) {
          expect(slot.size, slot.sticker).toBeGreaterThanOrEqual(15);
          expect(slot.size, slot.sticker).toBeLessThanOrEqual(65);
          expect(slot.left + slot.size, slot.sticker).toBeLessThanOrEqual(105);
          expect(slot.left, slot.sticker).toBeGreaterThanOrEqual(-5);
          expect(Math.abs(slot.tilt), slot.sticker).toBeLessThanOrEqual(1);
        }
        for (const slot of set.trio) {
          expect(slot.size, slot.sticker).toBeGreaterThanOrEqual(25);
          expect(slot.left + slot.size, slot.sticker).toBeLessThanOrEqual(105);
          expect(Math.abs(slot.tilt), slot.sticker).toBeLessThanOrEqual(1);
        }
        for (const chip of set.photo.chips) {
          expect(chip.left, chip.label).toBeGreaterThanOrEqual(0);
          expect(chip.left, chip.label).toBeLessThanOrEqual(100);
          expect(chip.top, chip.label).toBeGreaterThanOrEqual(0);
          expect(chip.top, chip.label).toBeLessThanOrEqual(100);
          expect(Math.abs(chip.rotate ?? 0), chip.label).toBeLessThanOrEqual(10);
        }
      });

      it("tags the photo with two distinct chips whose text is in the catalog and fits a tag", () => {
        expect(set.photo.chips).toHaveLength(2);
        expect(new Set(set.photo.chips.map((chip) => chip.label)).size).toBe(2);
        for (const chip of set.photo.chips) {
          expect(Object.prototype.hasOwnProperty.call(en, chip.label), chip.label).toBe(true);
          const text = en[chip.label as keyof typeof en];
          expect(text.length, chip.label).toBeGreaterThan(0);
          expect(text.length, chip.label).toBeLessThanOrEqual(CHIP_MAX_CHARS);
        }
      });

      it("names owners with a single made-up first name", () => {
        const owners = [set.photo.owner, ...Object.values(set.stickers).map((sticker) => sticker.owner)];
        for (const owner of owners) expect(owner, owner).toMatch(/^\p{Lu}\p{L}+$/u);
      });

      it(`weighs at most ${SET_BUDGET_BYTES / 1024} KB`, () => {
        const total = referencedFiles(set).reduce((sum, file) => sum + statSync(fileOf(file)).size, 0);
        expect(total).toBeLessThanOrEqual(SET_BUDGET_BYTES);
      });

      it("ships WebP pictures without EXIF, and with no XMP but the AI-generated marker", async () => {
        for (const file of referencedFiles(set)) {
          const meta = await sharp(fileOf(file)).metadata();
          expect(meta.format, file).toBe("webp");
          expect(meta.exif, file).toBeUndefined();
          expect(meta.iptc, file).toBeUndefined();
          if (UNMARKED_SETS.has(set.id)) {
            expect(meta.xmp, file).toBeUndefined();
            continue;
          }
          const xmp = meta.xmp?.toString("utf8") ?? "";
          expect(xmp, file).toContain(`<Iptc4xmpExt:DigitalSourceType>${AI_SOURCE_TYPE}</Iptc4xmpExt:DigitalSourceType>`);
          const elements = [...xmp.matchAll(/<([A-Za-z][\w-]*:[\w-]+)/g)].map((match) => match[1]);
          expect(elements.filter((name) => !XMP_ALLOWED.has(name)), file).toEqual([]);
        }
      });
    });
  }
});
