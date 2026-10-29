/**
 * Pure view-model for the Studio board page and create flow
 * (PIN-66, docs/11 section 6). Shapes mirror the public boards
 * API (PIN-65 board-api public* mappers) structurally, so the
 * client components and these helpers never import server code.
 */
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
}

/**
 * Join pins to their elements and owners for the grid, oldest
 * first so polling never reshuffles what is on screen. Pins
 * whose element is missing (deleted mid-poll) are skipped.
 */
export function pinCards(view: BoardViewLike): PinCard[] {
  const elementsById = new Map(view.elements.map((e) => [e.id, e]));
  const namesById = new Map(view.participants.map((p) => [p.id, p.displayName]));
  const cards: (PinCard & { createdAt: number })[] = [];
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
  return cards.map(({ createdAt: _createdAt, ...card }) => card);
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
