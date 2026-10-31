import type { LandingSet, LandingSticker } from "../domain/landing-sets";
import type { MessageKey } from "../i18n";

// The landing's showcase sets (PIN-175). The page picks one per request
// (src/domain/landing-sets.ts); the files live in
// public/landing/sets/<id>/ (provenance in public/landing/README.md).
// Every picture is synthetic and every owner a made-up first name.
// src/app/landing-sets.test.ts keeps this file and the folders in step.

/** A set's stickers: the file is `cutout-<id>.webp` in the set's folder. */
function stickers(dir: string, owners: Record<string, string>): Record<string, LandingSticker> {
  return Object.fromEntries(
    Object.entries(owners).map(([id, owner]) => [id, { src: `/landing/sets/${dir}/cutout-${id}.webp`, owner }]),
  );
}

/** Today's landing, unchanged: the mug and the duck on a desk, then on a picnic blanket. */
const CLASSIC: LandingSet<MessageKey> = {
  id: "classic",
  stickers: stickers("classic", {
    "red-alarm-clock": "Noor",
    "teal-mug": "Mia",
    "orange-tabby-cat": "Leo",
    "straw-hat": "Ava",
    "red-sneakers": "Jay",
    "rubber-duck": "Sam",
    "potted-succulent": "Ines",
  }),
  pile: [
    { sticker: "red-alarm-clock", left: 0, top: 12, size: 40, tilt: -0.85 },
    { sticker: "teal-mug", left: 31, top: -2, size: 44, tilt: 0.55 },
    { sticker: "orange-tabby-cat", left: 51, top: 25, size: 46, tilt: 0.7 },
    { sticker: "straw-hat", left: 3, top: 48, size: 38, tilt: -0.45 },
    { sticker: "red-sneakers", left: 26, top: 58, size: 48, tilt: 0.9 },
    { sticker: "rubber-duck", left: 30, top: 30, size: 28, tilt: -0.6, foil: true },
  ],
  photo: {
    src: "/landing/sets/classic/photo-desk-mug-duck.webp",
    owner: "Mia",
    objectPosition: "72% 50%",
    scale: 1.7,
    transformOrigin: "70% 82%",
    chips: [
      { label: "landing.sampleMug", left: 31, top: 24, rotate: -4 },
      { label: "landing.sampleDuck", left: 66, top: 87, rotate: 3 },
    ],
  },
  trio: [
    { sticker: "teal-mug", left: 2, top: 14, size: 58, tilt: -0.7 },
    { sticker: "rubber-duck", left: 46, top: 8, size: 38, tilt: 0.8 },
    { sticker: "potted-succulent", left: 52, top: 46, size: 42, tilt: 0.5 },
  ],
  scene: { src: "/landing/sets/classic/scene-picnic-mug-duck.webp", objectPosition: "50% 62%" },
};

/**
 * Try-on: Maya's mirror selfie, then friends' jacket, beret and
 * sunglasses, then a waist-up selfie wearing them (PIN-171 spike).
 */
const TRY_ON: LandingSet<MessageKey> = {
  id: "try-on",
  stickers: stickers("try-on", {
    woman: "Maya",
    "mustard-jacket": "Jo",
    "red-beret": "Lea",
    "tortoise-sunglasses": "Lea",
    "red-bag": "Nia",
    "suede-boot": "Zoe",
  }),
  pile: [
    { sticker: "woman", left: -4, top: 7, size: 56, tilt: -0.5 },
    { sticker: "mustard-jacket", left: 24, top: 0, size: 42, tilt: 0.6 },
    { sticker: "red-beret", left: 62, top: 2, size: 34, tilt: -0.7 },
    { sticker: "suede-boot", left: 66, top: 60, size: 30, tilt: 0.8, foil: true },
    { sticker: "red-bag", left: 20, top: 52, size: 38, tilt: -0.4 },
    { sticker: "tortoise-sunglasses", left: 54, top: 36, size: 36, tilt: 0.5 },
  ],
  photo: {
    src: "/landing/sets/try-on/photo-dresser-beret-sunglasses.webp",
    owner: "Lea",
    objectPosition: "50% 50%",
    chips: [
      { label: "landing.sampleBeret", left: 34, top: 16, rotate: -4 },
      { label: "landing.sampleSunglasses", left: 60, top: 60, rotate: 3 },
    ],
  },
  trio: [
    { sticker: "mustard-jacket", left: 0, top: 12, size: 58, tilt: -0.6 },
    { sticker: "red-beret", left: 50, top: 6, size: 42, tilt: 0.7 },
    { sticker: "tortoise-sunglasses", left: 44, top: 52, size: 48, tilt: 0.4 },
  ],
  scene: { src: "/landing/sets/try-on/scene-park-selfie.webp", objectPosition: "50% 50%" },
};

/**
 * Cat in borrowed gear: Aye's cat, Ben's beanie and heart sunglasses,
 * Kim's skateboard, then the cat skating down a street (PIN-171 spike).
 */
const CAT: LandingSet<MessageKey> = {
  id: "cat",
  stickers: stickers("cat", {
    "ginger-cat": "Aye",
    "green-beanie": "Ben",
    "heart-sunglasses": "Ben",
    skateboard: "Kim",
    "mint-headphones": "Rui",
    "paper-crown": "Rui",
  }),
  pile: [
    { sticker: "skateboard", left: -4, top: 9, size: 52, tilt: -0.6 },
    { sticker: "ginger-cat", left: 22, top: 16, size: 52, tilt: 0.4 },
    { sticker: "green-beanie", left: 58, top: 0, size: 34, tilt: 0.7 },
    { sticker: "mint-headphones", left: 66, top: 38, size: 32, tilt: -0.5, foil: true },
    { sticker: "paper-crown", left: 4, top: 66, size: 28, tilt: 0.6 },
    { sticker: "heart-sunglasses", left: 42, top: 60, size: 36, tilt: -0.8 },
  ],
  photo: {
    src: "/landing/sets/cat/photo-shelf-beanie-glasses.webp",
    owner: "Ben",
    objectPosition: "50% 50%",
    chips: [
      { label: "landing.sampleBeanie", left: 46, top: 30, rotate: -4 },
      { label: "landing.sampleHeartGlasses", left: 54, top: 68, rotate: 3 },
    ],
  },
  trio: [
    { sticker: "skateboard", left: -12, top: 14, size: 60, tilt: -0.5 },
    { sticker: "ginger-cat", left: 22, top: 22, size: 62, tilt: 0.4 },
    { sticker: "green-beanie", left: 56, top: 2, size: 40, tilt: 0.7 },
  ],
  scene: { src: "/landing/sets/cat/scene-street-skate.webp", objectPosition: "50% 50%" },
};

export const LANDING_SETS: readonly LandingSet<MessageKey>[] = [CLASSIC, TRY_ON, CAT];

/** The set drawn when an id is somehow not found: today's landing. */
export function landingSetById(id: string): LandingSet<MessageKey> {
  return LANDING_SETS.find((set) => set.id === id) ?? CLASSIC;
}
