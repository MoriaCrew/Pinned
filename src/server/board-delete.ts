import "server-only";
/**
 * Delete a board for everyone (PIN-167, docs/13-auth.md "Board
 * delete"): the host only; any other caller gets the one 404. The
 * repository tombstone comes first, so from then on every route
 * reads the board as missing and every write to it is refused —
 * nothing racing the row clean-up below can bring it back (the
 * index writer re-checks too). Jobs in flight are not waited for
 * (a stuck job must never block a delete). Last, the board's stored
 * objects go (PIN-169, board-storage.ts): best-effort, never thrown
 * to the caller, and a job that outlives the board sweeps again.
 */
import type { BoardRepository } from "../domain/board-repository";
import type { UserRepository } from "../domain/user-repository";
import type { Policy } from "../policy/policy";
import { BoardApiError } from "./board-session";
import { sweepDeletedBoardStorage } from "./board-storage";
import type { DerivativeStore } from "./derivative-store";
import { verifyHostToken } from "./host-session";
import { isSafeUid } from "./user-session";

export interface DeleteBoardDeps {
  boards: BoardRepository;
  users: UserRepository;
  store: DerivativeStore;
  /** The board's effective Policy (host token age). */
  policy: Policy;
  now?: () => number;
}

export async function deleteBoardForEveryone(
  slug: string,
  hostToken: string | null,
  deps: DeleteBoardDeps,
): Promise<void> {
  const board = await deps.boards.getBoard(slug);
  const now = deps.now?.() ?? Date.now();
  if (!board || !verifyHostToken(board, hostToken, deps.policy, now)) {
    throw new BoardApiError("Board not found.", 404);
  }
  // Only the call that set the tombstone answers 204; a concurrent
  // second delete gets the same 404 as an unknown board.
  if (!(await deps.boards.deleteBoard(slug, now))) {
    throw new BoardApiError("Board not found.", 404);
  }
  const uids = new Set(
    (await deps.boards.listParticipants(slug)).flatMap((p) =>
      p.userId && isSafeUid(p.userId) ? [p.userId] : [],
    ),
  );
  for (const uid of uids) {
    try {
      await deps.users.deleteUserBoard(uid, slug);
    } catch (error) {
      // Best-effort: the board is already gone for everyone. Logged
      // by error name only — never the slug (a capability) or a uid.
      console.error("Board delete left a My boards row behind.", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  await sweepDeletedBoardStorage(slug, deps);
}
