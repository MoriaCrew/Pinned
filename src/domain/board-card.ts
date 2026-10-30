/**
 * Board link card (PIN-102): the 1200 x 630 image a chat app shows
 * when someone pastes a board link (/g/{slug}), drawn in the board's
 * skin with the board's own pinned cut-outs as die-cut stickers
 * (design: the LinkPreview component of the design system, docs/14).
 *
 * Pure: what the card says and where things go. Loading bytes,
 * baking keylines (sharp) and rendering (next/og) live in
 * src/server/board-card.ts and src/server/board-card-image.tsx.
 * Only pinned elements ever reach the card, never candidates and
 * never tmp/ working copies (same rule as the element image route).
 */
import type { Board, Element, Participant, Pin, Scene } from "./board";
import { skinForTheme, stickerTilt, type SkinId } from "./skins";
import { t, tCount, tf } from "../i18n";

/** Open Graph image size (the 1.91:1 large-image card). */
export const CARD_SIZE = { width: 1200, height: 630 } as const;

/**
 * App CSS px -> card px. The design system draws this card about
 * 436px wide in the app, so keylines, shadows and pattern sizes
 * written in app px (src/ui/pinneds.css) scale by 1200 / 436.
 */
export const CARD_UI_SCALE = 2.75;

/** One "cqw" of the design: 1% of the card width. */
const CQW = CARD_SIZE.width / 100;

/** Sticker box in card px: top-left corner and square size. */
export interface CardSlot {
  x: number;
  y: number;
  size: number;
}

function slots(spec: ReadonlyArray<readonly [number, number, number]>): CardSlot[] {
  return spec.map(([l, t, s]) => ({ x: l * CQW, y: t * CQW, size: s * CQW }));
}

/**
 * Pile layouts by sticker count, in cqw (left, top, size). Five is
 * the design's own pile (LinkPreview PILE); fewer stickers get a
 * balanced pile of their own instead of a half-empty five.
 */
const PILES: readonly CardSlot[][] = [
  [],
  slots([[59, 9, 33]]),
  slots([[56, 4, 28], [72, 21, 27]]),
  slots([[56, 3, 26], [76, 8, 22], [62, 23, 27]]),
  slots([[56, 3, 26], [75, 6, 23], [57, 26, 24], [74, 25, 25]]),
  slots([[58, 3, 24], [77, 8, 21], [55, 26, 22], [74, 28, 24], [67, 15, 18]]),
];

/** Most stickers a card shows (the design's pile). */
export const CARD_MAX_STICKERS = PILES.length - 1;

/** Pile slots for `count` stickers (clamped to the design's five). */
export function pileSlots(count: number): CardSlot[] {
  const n = Math.max(0, Math.min(CARD_MAX_STICKERS, Math.floor(count)));
  return PILES[n].map((slot) => ({ ...slot }));
}

/** Dashed ghost outlines a board with no pins yet shows instead. */
export const GHOST_SLOTS: readonly CardSlot[] = slots([
  [60, 9, 17],
  [77, 14, 14],
  [65, 27, 16],
]);

/**
 * Per-skin look of the card, mirrored from the `[data-theme]` blocks
 * in src/ui/pinneds.css (board-card.test.ts fails when they drift).
 * Colours come from src/ui/tokens.json at render time.
 */
export interface CardSkinStyle {
  display: {
    /** Font family name registered with the renderer. */
    family: string;
    weight: number;
    style: "normal" | "italic";
    /** --display-scale */
    scale: number;
    /** --display-tracking, in em */
    trackingEm: number;
    /** --display-transform: uppercase */
    uppercase: boolean;
  };
  /** --tilt: the skin's largest sticker angle, degrees. */
  tiltDeg: number;
  /** --kw: white keyline width in app px (0 = no keyline). */
  keylinePx: number;
  /** --lift drop-shadow in app px; blur 0 = hard offset shadow. */
  lift: { x: number; y: number; blur: number };
  /** Cork pins its stickers with a pushpin (--pushpin). */
  pushpin: boolean;
  /** Top band (--band): Postcard airmail stripes, Marigold papel picado. */
  band: "airmail" | "picado" | null;
  /** Ground pattern (--board-pattern), drawn simply. */
  ground: "speckle" | "sheen" | "dots" | "confetti" | null;
}

export const CARD_SKIN_STYLES: Readonly<Record<SkinId, CardSkinStyle>> = {
  paper: {
    display: { family: "Bricolage Grotesque", weight: 800, style: "normal", scale: 1, trackingEm: -0.025, uppercase: false },
    tiltDeg: 3,
    keylinePx: 3,
    lift: { x: 0, y: 6, blur: 6 },
    pushpin: false,
    band: null,
    ground: null,
  },
  cork: {
    display: { family: "Fraunces", weight: 600, style: "normal", scale: 1, trackingEm: -0.01, uppercase: false },
    tiltDeg: 5,
    keylinePx: 3,
    lift: { x: 0, y: 7, blur: 5 },
    pushpin: true,
    band: null,
    ground: "speckle",
  },
  fridge: {
    display: { family: "Fredoka", weight: 600, style: "normal", scale: 1, trackingEm: -0.01, uppercase: false },
    tiltDeg: 1.5,
    keylinePx: 4,
    lift: { x: 0, y: 4, blur: 4 },
    pushpin: false,
    band: null,
    ground: "sheen",
  },
  zine: {
    display: { family: "Anton", weight: 400, style: "normal", scale: 1.16, trackingEm: 0.01, uppercase: true },
    tiltDeg: 5,
    keylinePx: 0,
    lift: { x: 4, y: 4, blur: 0 },
    pushpin: false,
    band: null,
    ground: "dots",
  },
  darkroom: {
    display: { family: "Instrument Serif", weight: 400, style: "italic", scale: 1.18, trackingEm: -0.01, uppercase: false },
    tiltDeg: 0,
    keylinePx: 2,
    lift: { x: 0, y: 8, blur: 10 },
    pushpin: false,
    band: null,
    ground: null,
  },
  postcard: {
    display: { family: "Young Serif", weight: 400, style: "normal", scale: 0.95, trackingEm: -0.005, uppercase: false },
    tiltDeg: 1.5,
    keylinePx: 3,
    lift: { x: 0, y: 5, blur: 5 },
    pushpin: false,
    band: "airmail",
    ground: null,
  },
  marigold: {
    display: { family: "Abril Fatface", weight: 400, style: "normal", scale: 1.04, trackingEm: 0, uppercase: false },
    tiltDeg: 3,
    keylinePx: 3,
    lift: { x: 0, y: 6, blur: 6 },
    pushpin: false,
    band: "picado",
    ground: "confetti",
  },
};

export interface CardCounts {
  people: number;
  things: number;
  scenes: number;
}

export interface CardModel {
  skin: SkinId;
  title: string;
  /** Display name of whoever joined first; null drops the phrase. */
  inviter: string | null;
  counts: CardCounts;
  /** Pinned element ids for the pile, newest pin first. */
  stickerIds: string[];
}

export interface CardModelInput {
  board: Pick<Board, "slug" | "title" | "themeId">;
  participants: ReadonlyArray<Pick<Participant, "id" | "displayName" | "createdAt">>;
  pins: ReadonlyArray<Pick<Pin, "id" | "elementId" | "status" | "createdAt">>;
  elements: ReadonlyArray<Pick<Element, "id" | "boardId" | "cutoutRef">>;
  scenes: ReadonlyArray<Pick<Scene, "status" | "hidden">>;
}

function byCreatedThenId<T extends { createdAt: number; id: string }>(a: T, b: T): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/** Anything outside the card's bundled Latin fonts (src/server/og-fonts). */
const OUTSIDE_CARD_FONTS = /[^ -~ -ſ‐-‧‰-›€™]/gu;

/**
 * Text as the card can draw it: characters the bundled fonts lack
 * (emoji, other scripts) are left out, so the renderer never fetches
 * a font or emoji image from a third party with board text in the
 * request, and an emoji never breaks the card.
 */
export function cardText(value: string): string {
  return value.replace(OUTSIDE_CARD_FONTS, "").replace(/\s+/g, " ").trim();
}

/**
 * What the card shows for a board. There is no board creator
 * record, so the inviter is the earliest participant. Things are
 * pinned pins whose element is still on this board with a stored
 * cut-out under elements/; candidates never count or show. A title
 * with nothing drawable left falls back to the brand line.
 */
export function cardModel(input: CardModelInput): CardModel {
  const { board } = input;
  const first = [...input.participants].sort(byCreatedThenId)[0];
  const inviter = first ? cardText(first.displayName) || null : null;

  const elements = new Map(
    input.elements
      .filter((el) => el.boardId === board.slug && el.cutoutRef.startsWith("elements/"))
      .map((el) => [el.id, el]),
  );
  const pinned = input.pins
    .filter((pin) => pin.status === "pinned" && elements.has(pin.elementId))
    .sort((a, b) => -byCreatedThenId(a, b));
  const stickerIds: string[] = [];
  for (const pin of pinned) {
    if (stickerIds.length >= CARD_MAX_STICKERS) break;
    if (!stickerIds.includes(pin.elementId)) stickerIds.push(pin.elementId);
  }

  return {
    skin: skinForTheme(board.themeId),
    title: cardText(board.title) || t("en", "card.fallbackTitle"),
    inviter,
    counts: {
      people: input.participants.length,
      things: new Set(pinned.map((pin) => pin.elementId)).size,
      scenes: input.scenes.filter((scene) => scene.status === "ready" && !scene.hidden).length,
    },
    stickerIds,
  };
}

/** Invite line above the title. */
export function cardInviteLine(inviter: string | null): string {
  return inviter ? tf("en", "card.invite", { name: inviter }) : t("en", "card.inviteAnyone");
}

/** "6 people · 14 things · 2 scenes", leaving out zero counts. */
export function cardMetaLine(counts: CardCounts): string {
  const parts: string[] = [];
  if (counts.people > 0) parts.push(tCount("en", "meta.people", counts.people));
  if (counts.things > 0) parts.push(tCount("en", "meta.things", counts.things));
  if (counts.scenes > 0) parts.push(tCount("en", "meta.scenes", counts.scenes));
  return parts.join(" · ");
}

/** Title as drawn: the skin's case (Zine is all capitals). */
export function cardTitleText(title: string, skin: SkinId): string {
  return CARD_SKIN_STYLES[skin].display.uppercase ? title.toLocaleUpperCase("en") : title;
}

/**
 * Title font size in card px. The design size (6.8cqw x the skin's
 * display scale) fits about two lines of a short name; longer names
 * and long single words step down so the title stays inside the
 * copy column (the renderer cannot measure text before drawing).
 */
export function cardTitleSize(title: string, skin: SkinId): number {
  const base = 6.8 * CQW * CARD_SKIN_STYLES[skin].display.scale;
  const length = [...title].length;
  const longestWord = Math.max(0, ...title.split(/\s+/).map((word) => [...word].length));
  let step = 1;
  if (length > 24 || longestWord > 11) step = 0.8;
  if (length > 40 || longestWord > 14) step = 0.64;
  if (length > 60 || longestWord > 18) step = 0.52;
  return Math.round(base * step * 10) / 10;
}

/** Sticker angle in degrees: the board's stable lean for that thing. */
export function cardStickerTilt(seed: string, skin: SkinId): number {
  return stickerTilt(seed) * CARD_SKIN_STYLES[skin].tiltDeg;
}
