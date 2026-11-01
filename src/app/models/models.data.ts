import type { MessageKey } from "../../i18n";
import type { Person } from "../../ui";
import { SOURCE_URL } from "../_legal/LegalParts";
import { landingSetById } from "../landing-sets.data";

// Data for /models (PIN-237). The walk-through's worked example is the
// cat showcase set, made end to end with Meta models
// (public/landing/README.md): Muse Image made the friends' photos,
// Muse Spark named the things, SAM 3.1 cut them out and Muse Image
// composed the scene. Never the classic set: its photos are not
// Meta-made. Owners are the set's made-up first names.
const SET = landingSetById("cat");

/** The developer version of /models, linked from its footer. */
export const MODELS_DOC_URL = `${SOURCE_URL}/blob/main/docs/19-meta-models.md`;

/** Product names, never translated (src/i18n/glossary.json doNotTranslate). */
export const MODEL_NAMES = {
  spark: "Muse Spark",
  sam: "SAM 3.1",
  image: "Muse Image",
  voice: "Muse Voice Transcribe",
  open: "Muse Spark Open",
} as const;

export interface ExamplePin {
  sticker: string;
  label: MessageKey;
  src: string;
  owner: Person;
}

/** A thing in the step-1 photo; `box` is in percent of the square photo, measured on the shipped file. */
export interface ExampleThing extends ExamplePin {
  box: { left: number; top: number; width: number; height: number };
}

function pin(sticker: string, label: MessageKey): ExamplePin {
  const entry = SET.stickers[sticker];
  if (!entry) throw new Error(`models example: no sticker ${sticker} in set ${SET.id}`);
  return { sticker, label, src: entry.src, owner: { id: entry.owner, name: entry.owner } };
}

export const EXAMPLE = {
  setId: SET.id,
  photo: { src: SET.photo.src, owner: SET.photo.owner },
  things: [
    { ...pin("green-beanie", "landing.sampleBeanie"), box: { left: 4.5, top: 39.5, width: 52.5, height: 33.5 } },
    { ...pin("heart-sunglasses", "landing.sampleHeartGlasses"), box: { left: 60.5, top: 48, width: 34.5, height: 15 } },
  ] satisfies ExampleThing[],
  /** The scene's pins, in pick order (public/landing/README.md, scene-street-skate). */
  picks: [
    pin("ginger-cat", "models.thingCat"),
    pin("green-beanie", "landing.sampleBeanie"),
    pin("heart-sunglasses", "landing.sampleHeartGlasses"),
    pin("skateboard", "models.thingSkateboard"),
  ],
  scene: SET.scene.src,
};
