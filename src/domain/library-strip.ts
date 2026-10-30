/**
 * "From your other boards" strip in the Add sheet (PIN-121). Pure:
 * the sheet feeds it the signed-in state, the library query and the
 * board view, and renders whatever this returns. The full list
 * behind "See all" uses `libraryPinState` for its rows too, so a
 * thing pinned from the strip reads "Pinned" in the list as well.
 */
import type { MyPinCard } from "./my-pins";

/** One library thing's pin-here state on this board. */
export type LibraryPinState = "idle" | "pinning" | "pinned" | "already" | "failed";

/**
 * Sticker placeholders while the library loads. A visual stand-in
 * for "about four on a phone", not a limit: the strip's real cap is
 * Policy.libraryStripMax.
 */
export const STRIP_PLACEHOLDER_COUNT = 4;

/** A copy shares its family with the original it was pinned from. */
export function familyOf(card: Pick<MyPinCard, "elementId" | "familyId">): string {
  return card.familyId ?? card.elementId;
}

/** The pieces of the board view the strip reads. */
export interface StripBoardLike {
  pins: readonly { elementId: string; status: "candidate" | "pinned" }[];
  elements: readonly { id: string }[];
}

/**
 * Library families that already have a pinned member on this board.
 * A cross-board pin lands as a COPY with a new id, so this matches
 * on family: once the library is refetched it holds the copy (same
 * familyId as the original), and every member of that family (the
 * original on board A, an earlier copy on board B) reads as here.
 */
export function familiesOnBoard(
  cards: readonly MyPinCard[],
  board: StripBoardLike,
): Set<string> {
  const pinned = new Set(
    board.pins.filter((pin) => pin.status === "pinned").map((pin) => pin.elementId),
  );
  const families = new Set<string>();
  for (const card of cards) {
    if (pinned.has(card.elementId)) families.add(familyOf(card));
  }
  return families;
}

/**
 * What a library thing shows: what this sheet just did to its family
 * wins (so "Pinned" stays "Pinned" after the refetches add the copy,
 * and a sibling row of the same thing reads "Pinned" too instead of
 * staying tappable), else "Already here" when its family is pinned
 * on the board. `local` is keyed by family (familyOf).
 */
export function libraryPinState(
  card: MyPinCard,
  local: ReadonlyMap<string, LibraryPinState>,
  onBoard: ReadonlySet<string>,
): LibraryPinState {
  const mine = local.get(familyOf(card));
  if (mine) return mine;
  return onBoard.has(familyOf(card)) ? "already" : "idle";
}

export interface StripItem {
  card: MyPinCard;
  state: LibraryPinState;
}

export type LibraryStripView =
  /** Signed out, sign-in off, or nothing from other boards: no heading at all. */
  | { kind: "hidden" }
  | { kind: "loading"; placeholders: number }
  | { kind: "error" }
  | { kind: "items"; items: StripItem[] };

/**
 * The strip's state. Things that live on this board (its own
 * things, or copies already pinned here) are not "from your other
 * boards", so they are left out; a family pinned here through a copy
 * shows its original as "Already here". One sticker per family
 * (newest first, as the library sorts), capped at
 * Policy.libraryStripMax.
 */
export function libraryStripView(input: {
  signedIn: boolean;
  status: "pending" | "error" | "success";
  cards: readonly MyPinCard[] | undefined;
  board: StripBoardLike;
  local: ReadonlyMap<string, LibraryPinState>;
  max: number;
}): LibraryStripView {
  // Policy.libraryStripMax 0 turns the strip off.
  if (!input.signedIn || input.max <= 0) return { kind: "hidden" };
  if (input.status === "pending") {
    return { kind: "loading", placeholders: Math.min(STRIP_PLACEHOLDER_COUNT, input.max) };
  }
  if (input.status === "error" || !input.cards) return { kind: "error" };
  const cards = input.cards;
  const onBoard = familiesOnBoard(cards, input.board);
  const here = new Set(input.board.elements.map((element) => element.id));
  const seen = new Set<string>();
  const items: StripItem[] = [];
  for (const card of cards) {
    if (items.length >= input.max) break;
    if (here.has(card.elementId)) continue;
    const family = familyOf(card);
    if (seen.has(family)) continue;
    seen.add(family);
    items.push({ card, state: libraryPinState(card, input.local, onBoard) });
  }
  return items.length === 0 ? { kind: "hidden" } : { kind: "items", items };
}
