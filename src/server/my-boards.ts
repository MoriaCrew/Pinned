import "server-only";
/**
 * My boards assembly (PIN-84, docs/11 section 5.4): the signed-in
 * user's board index joined to live board data. Entries whose
 * board is gone, or whose participant no longer carries this
 * user's claim, are skipped rather than shown stale. Board links
 * in the cards are the slugs themselves — the index only holds
 * boards the user already reached by link and claimed.
 */
import type { BoardRepository } from "../domain/board-repository";
import { getBoardTheme } from "../domain/board-themes";
import { pickLatestPreviewScene } from "../domain/board-preview";
import { sortMyBoards, type MyBoardCard } from "../domain/my-boards";
import type { UserProfile } from "../domain/user";
import type { UserRepository } from "../domain/user-repository";

export interface MyBoardsDeps {
  boards: BoardRepository;
  users: UserRepository;
}

export async function listMyBoards(
  user: UserProfile,
  deps: MyBoardsDeps,
): Promise<MyBoardCard[]> {
  const entries = await deps.users.listUserBoards(user.uid);
  const cards: MyBoardCard[] = [];
  for (const entry of entries) {
    const board = await deps.boards.getBoard(entry.boardId);
    if (!board) continue;
    const participant = await deps.boards.getParticipant(
      entry.boardId,
      entry.participantId,
    );
    if (!participant || participant.userId !== user.uid) continue;

    const [elements, pins, scenes, events] = await Promise.all([
      deps.boards.listElementsByOwner(entry.boardId, participant.id),
      deps.boards.listPins(entry.boardId, "pinned"),
      deps.boards.listScenes(entry.boardId),
      deps.boards.listEvents(entry.boardId, { limit: 1 }),
    ]);
    const myElementIds = new Set(elements.map((e) => e.id));
    const myPinCount = pins.filter((p) => myElementIds.has(p.elementId)).length;
    const latestScene = pickLatestPreviewScene(scenes);
    const lastActivityAt = Math.max(
      board.createdAt,
      entry.updatedAt,
      ...pins.map((p) => p.createdAt),
      ...scenes.map((s) => s.createdAt),
      ...events.map((e) => e.createdAt),
    );
    const theme = getBoardTheme(board.themeId);
    cards.push({
      slug: board.slug,
      title: board.title,
      themeId: board.themeId ?? null,
      themeLabel: theme?.label ?? null,
      themeMotif: theme?.motif ?? null,
      myPinCount,
      latestSceneImageUrl: latestScene
        ? `/api/boards/${encodeURIComponent(board.slug)}/scenes/${encodeURIComponent(latestScene.id)}/image?size=preview`
        : null,
      lastActivityAt,
      claimedAt: entry.claimedAt,
    });
  }
  return sortMyBoards(cards);
}
