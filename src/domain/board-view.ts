/**
 * Pure view-model for the Studio board page and create flow
 * (PIN-66, docs/11 section 6). Shapes mirror the public boards
 * API (PIN-65 board-api public* mappers) structurally, so the
 * client components and these helpers never import server code.
 */
import type { CollageReason } from "./board";
import { isBoardThemeId } from "./board-themes";

export interface BoardViewParticipant {
  id: string;
  displayName: string;
}

export interface BoardViewElement {
  id: string;
  ownerId: string;
  label: string;
  faceFlag: boolean;
  imageUrl: string;
}

export interface BoardViewPin {
  id: string;
  elementId: string;
  pinnedBy: string;
  status: "candidate" | "pinned";
  createdAt: number;
  /** The photo job of the viewer's OWN candidate (PIN-122); absent otherwise. */
  jobId?: string;
}

export interface BoardViewScene {
  /** Remix parent scene id (PIN-79, §5.7); absent on fresh scenes. */
  parentSceneId?: string;
  id: string;
  createdBy: string;
  elementIds: string[];
  prompt: string;
  status: "pending" | "running" | "ready" | "failed" | "refused";
  /** PIN-71: "collage" = sharp mock-collage fallback, not AI output. */
  kind?: "ai" | "collage";
  /** PIN-180: why a collage is a collage; absent on older collages and AI scenes. */
  collageReason?: CollageReason;
  refusalReason?: string;
  /** Stored image pixel size (PIN-129); absent on older scenes. */
  width?: number;
  height?: number;
  imageUrl: string | null;
  /** Phone-sized strip image (PIN-133); the viewer and Share use imageUrl. */
  previewUrl?: string | null;
  createdAt: number;
  /** Board view only (PIN-143): the viewer is its maker or the host. A UI hint; the server enforces. */
  canDelete?: boolean;
  /** Board view only (PIN-143): a remix whose parent was deleted. */
  parentDeleted?: boolean;
}

export interface BoardViewLike {
  participants: BoardViewParticipant[];
  elements: BoardViewElement[];
  pins: BoardViewPin[];
}

export interface PinCard {
  pinId: string;
  element: BoardViewElement;
  status: "candidate" | "pinned";
  /** Element owner's display name; null when unknown (UI falls back). */
  ownerName: string | null;
  ownerId: string;
  /** Pin time (server clock): the filter row's New chip and activity order (PIN-218). */
  createdAt: number;
}

/**
 * Join pins to their elements and owners for the grid, oldest
 * first so polling never reshuffles what is on screen. Pins
 * whose element is missing (deleted mid-poll) are skipped.
 */
export function pinCards(view: BoardViewLike): PinCard[] {
  const elementsById = new Map(view.elements.map((e) => [e.id, e]));
  const namesById = new Map(view.participants.map((p) => [p.id, p.displayName]));
  const cards: PinCard[] = [];
  for (const pin of view.pins) {
    const element = elementsById.get(pin.elementId);
    if (!element) continue;
    cards.push({
      pinId: pin.id,
      element,
      status: pin.status,
      ownerName: namesById.get(element.ownerId) ?? null,
      ownerId: element.ownerId,
      createdAt: pin.createdAt,
    });
  }
  cards.sort((a, b) => a.createdAt - b.createdAt || a.pinId.localeCompare(b.pinId));
  return cards;
}

/**
 * Own pins only (PIN-77): the delete affordance renders only
 * when the viewer is the element's owner — Element.ownerId,
 * not Pin.pinnedBy, matching the server's owner-only check.
 * The server still enforces it; this only hides the button.
 */
export function canDeleteCard(
  card: Pick<PinCard, "ownerId">,
  meId: string | null | undefined,
): boolean {
  return meId !== null && meId !== undefined && card.ownerId === meId;
}

/** Never-empty rule (docs/11 section 6): prompt until a real pin lands. */
export function needsEmptyPrompt(view: BoardViewLike): boolean {
  return !view.pins.some((pin) => pin.status === "pinned");
}

export type CreateBoardPayloadResult =
  | { ok: true; payload: { title: string; themeId?: string } }
  | { ok: false; reason: "empty" | "tooLong" | "badTheme" };

/** Client mirror of the server create-board validation (PIN-65). */
export function createBoardPayload(
  rawTitle: string,
  themeId: string | null,
  boardTitleMaxChars: number,
): CreateBoardPayloadResult {
  const title = rawTitle.trim().replace(/\s+/g, " ");
  if (!title) return { ok: false, reason: "empty" };
  if ([...title].length > boardTitleMaxChars) return { ok: false, reason: "tooLong" };
  if (themeId !== null && themeId !== "" && !isBoardThemeId(themeId)) {
    return { ok: false, reason: "badTheme" };
  }
  return {
    ok: true,
    payload: { title, ...(themeId ? { themeId } : {}) },
  };
}
