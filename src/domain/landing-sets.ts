/**
 * Landing showcase sets (PIN-175): the hero sticker pile and the three
 * "How it works" pictures are drawn from one curated set picked per
 * request, so a returning visitor sees something different. This file
 * is the pure part: the data shape and the picking. The sets
 * themselves live next to the page (`src/app/landing-sets.data.ts`)
 * and the files under `public/landing/sets/<id>/`.
 *
 * All positions are percentages of the box they sit in, so a set can
 * be placed without CSS of its own. Owners are fictional first names
 * (the pictures are synthetic); `Label` is the i18n key type, so the
 * data file is checked at compile time without this module reading
 * the catalog.
 */

/** A cut-out (public URL path) and the fictional friend it belongs to. */
export interface LandingSticker {
  src: string;
  owner: string;
}

/** One sticker of the hero pile: % of the pile box, tilt as a factor (-1..1). */
export interface LandingPileSlot {
  sticker: string;
  left: number;
  top: number;
  size: number;
  tilt: number;
  foil?: boolean;
}

/**
 * A name tag over the step-1 photo. `left` / `top` are the tag's
 * centre in % of the picture's box, `rotate` in degrees. Anchors are
 * data (not CSS classes) so they can follow a real segmentation box.
 */
export interface LandingChip<Label extends string = string> {
  label: Label;
  left: number;
  top: number;
  rotate?: number;
}

/** The step-1 photo: its crop (CSS `object-position`, zoom) and its two tags. */
export interface LandingPhoto<Label extends string = string> {
  src: string;
  owner: string;
  objectPosition: string;
  scale?: number;
  transformOrigin?: string;
  chips: readonly [LandingChip<Label>, LandingChip<Label>];
}

/** One of the three stickers of step 2: % of the art box. */
export interface LandingTrioSlot {
  sticker: string;
  left: number;
  top: number;
  size: number;
  tilt: number;
}

/** The step-3 scene print (square frame; `objectPosition` picks the crop). */
export interface LandingScene {
  src: string;
  objectPosition: string;
}

export interface LandingSet<Label extends string = string> {
  /** URL-safe; the value of `?set=`. */
  id: string;
  /** Sticker id → file and owner; the pile, the trio and the credits refer to these. */
  stickers: Readonly<Record<string, LandingSticker>>;
  /** 5 to 7 slots. */
  pile: readonly LandingPileSlot[];
  photo: LandingPhoto<Label>;
  trio: readonly [LandingTrioSlot, LandingTrioSlot, LandingTrioSlot];
  scene: LandingScene;
}

/** The `?set=` ids a set may have: lowercase words joined by single hyphens. */
export const LANDING_SET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `random()` as Math.random: a number in [0, 1). A stray 1 cannot index past the end. */
function pickIndex(length: number, random: () => number): number {
  return Math.min(length - 1, Math.floor(random() * length));
}

/**
 * The set to show: a requested id that exists wins (so a link can pin
 * one); a missing, unknown or repeated (`?set=a&set=b`) value is a
 * random pick. `random` is injected so the choice is testable.
 */
export function pickLandingSet(
  ids: readonly string[],
  opts: { requested?: string | readonly string[] | null; random: () => number },
): string {
  if (ids.length === 0) throw new Error("No landing sets to pick from");
  const { requested, random } = opts;
  if (typeof requested === "string" && ids.includes(requested)) return requested;
  return ids[pickIndex(ids.length, random)] as string;
}

/**
 * A set other than `currentId`, uniformly among the rest. With only
 * one set there is nothing else to show, so that set comes back.
 */
export function anotherLandingSet(ids: readonly string[], currentId: string, random: () => number): string {
  if (ids.length === 0) throw new Error("No landing sets to pick from");
  const others = ids.filter((id) => id !== currentId);
  if (others.length === 0) return currentId;
  return others[pickIndex(others.length, random)] as string;
}
