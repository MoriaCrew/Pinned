/**
 * "My boards" card model (PIN-84, docs/11 section 5.4). Pure:
 * the server assembles cards from the user board index +
 * BoardRepository, the /me/boards page and GET /api/me/boards
 * share this shape, and ordering is unit-tested here.
 */

export interface MyBoardCard {
  slug: string;
  title: string;
  themeId: string | null;
  themeLabel: string | null;
  themeMotif: string | null;
  /** Pinned pins whose element this participant owns. */
  myPinCount: number;
  /** Latest scene image route URL, or null when no scene is ready. */
  latestSceneImageUrl: string | null;
  /** Epoch-ms of the newest activity signal (see server/my-boards). */
  lastActivityAt: number;
  claimedAt: number;
}

/**
 * Newest activity first; ties break on claimedAt (newest first),
 * then slug, so polling/refreshing never reshuffles equal cards.
 */
export function sortMyBoards(cards: readonly MyBoardCard[]): MyBoardCard[] {
  return [...cards].sort(
    (a, b) =>
      b.lastActivityAt - a.lastActivityAt ||
      b.claimedAt - a.claimedAt ||
      a.slug.localeCompare(b.slug),
  );
}
