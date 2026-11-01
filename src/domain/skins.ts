/**
 * Board skins (PIN-96, design system v1). A skin is a complete look
 * for one board: colours, the display face, the sticker treatment
 * and motion, all switched by `data-theme="<skin id>"` on the board
 * root (tokens in src/ui/tokens.json). Skins never change layout,
 * sizes, icons, the reading font or the focus ring.
 *
 * Storage: a board keeps its skin id in the existing `themeId`
 * field. Boards made before the rebuild store a first-generation
 * theme id (PIN-52 looks); `skinForTheme` maps those onto free
 * skins so old links keep working with no migration.
 */

export const SKIN_IDS = [
  "paper",
  "cork",
  "fridge",
  "zine",
  "darkroom",
  "postcard",
  "marigold",
] as const;

export type SkinId = (typeof SKIN_IDS)[number];

export interface Skin {
  id: SkinId;
  /** Board Plus skin: anyone can try it on; keeping it needs Plus. */
  plus: boolean;
  /** Seasonal drop (shown with its season; still a Plus skin). */
  seasonal: boolean;
}

export const DEFAULT_SKIN: SkinId = "paper";

export const SKINS: readonly Skin[] = [
  { id: "paper", plus: false, seasonal: false },
  { id: "cork", plus: false, seasonal: false },
  { id: "fridge", plus: false, seasonal: false },
  { id: "zine", plus: false, seasonal: false },
  { id: "darkroom", plus: true, seasonal: false },
  { id: "postcard", plus: true, seasonal: false },
  { id: "marigold", plus: true, seasonal: true },
];

/**
 * First-generation theme ids (PIN-41/52 looks) → the closest free
 * skin. Free on purpose: a board never loses its look, and never
 * gains a Plus skin it did not choose.
 */
export const LEGACY_THEME_SKINS: Readonly<Record<string, SkinId>> = {
  helpdesk: "paper",
  gran: "cork",
  commentator: "zine",
  chef: "fridge",
  pirate: "cork",
  detective: "paper",
  cat: "fridge",
  astronaut: "paper",
};

export function isSkinId(value: unknown): value is SkinId {
  return typeof value === "string" && (SKIN_IDS as readonly string[]).includes(value);
}

export function getSkin(id: SkinId): Skin {
  return SKINS.find((skin) => skin.id === id) ?? SKINS[0];
}

export function isPlusSkinId(value: unknown): boolean {
  return isSkinId(value) && getSkin(value).plus;
}

/** The skin a stored board theme id renders with; unknown → Paper. */
export function skinForTheme(themeId: string | null | undefined): SkinId {
  if (isSkinId(themeId)) return themeId;
  if (themeId && Object.prototype.hasOwnProperty.call(LEGACY_THEME_SKINS, themeId)) {
    return LEGACY_THEME_SKINS[themeId];
  }
  return DEFAULT_SKIN;
}

/** Number of person colours the tokens define (`--person-1…6`). */
export const PERSON_COLOR_COUNT = 6;

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Stable person colour index (1-based) for `--person-<n>`. The same
 * person keeps the same colour on every board and device.
 */
export function personColorIndex(personId: string): number {
  return (hashSeed(personId) % PERSON_COLOR_COUNT) + 1;
}

/**
 * Stable tilt factor in [-1, 1] for a sticker; the skin's `--tilt`
 * token sets the maximum angle. The same thing always leans the
 * same way.
 */
export function stickerTilt(seed: string | null | undefined): number {
  if (!seed) return 0;
  return Math.round(((hashSeed(seed) % 2001) / 1000 - 1) * 100) / 100;
}
