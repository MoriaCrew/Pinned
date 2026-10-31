/**
 * "My pins" library card model (PIN-85, docs/11 section 5.4).
 * Pure: the server assembles cards from the user board index +
 * BoardRepository; GET /api/me/elements, the /me/pins page and
 * the board Add sheet tab share this shape. Cards carry the
 * source board TITLE only — never its slug — so a library
 * response cannot be mined for board capability links beyond
 * what My boards already shows the same signed-in user.
 */

export interface MyPinCard {
  elementId: string;
  /**
   * The family a library copy belongs to (PIN-121): the original
   * element's id (Element.sourceElementId), or the element's own
   * id when it is an original. Copies are only ever made from the
   * user's own things, so it tells the Add sheet which things are
   * already on a board without exposing anything new. Optional for
   * older payloads.
   */
  familyId?: string;
  label: string;
  description: string;
  faceFlag: boolean;
  /** Title (never slug) of the board the element lives on. */
  sourceBoardTitle: string;
  /** Owner-checked thumbnail route (no board slug in the URL). */
  imageUrl: string;
  createdAt: number;
}

/** Newest first; ties break on elementId so order is stable. */
export function sortMyPins(cards: readonly MyPinCard[]): MyPinCard[] {
  return [...cards].sort(
    (a, b) =>
      b.createdAt - a.createdAt || a.elementId.localeCompare(b.elementId),
  );
}

/** Clamp a requested page size to 1..Policy.libraryPageSize. */
export function clampLibraryLimit(
  requested: number | null | undefined,
  pageSize: number,
): number {
  if (requested === null || requested === undefined || !Number.isFinite(requested)) {
    return pageSize;
  }
  return Math.min(pageSize, Math.max(1, Math.floor(requested)));
}
