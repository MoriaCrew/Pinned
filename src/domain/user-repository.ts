/**
 * UserRepository port (PIN-83, docs/11 section 5.4). The in-memory
 * implementation below is the test double and the contract; the
 * Firestore implementation (src/server/firestore-user-repository.ts)
 * must pass the same suite (`user-repository.contract.ts`).
 *
 * Contract highlights every implementation must keep:
 * - Reads return isolated copies; writes store copies.
 * - Puts upsert by uid / (uid, boardId); no board need exist —
 *   the index is a plain per-user map keyed by board slug.
 * - listUserBoards is claimedAt-ascending; ties keep write order.
 * - Firestore home: users/{uid} + users/{uid}/boards/{slug},
 *   doc-get/subcollection reads only — no new index.
 */
import type { UserBoardEntry, UserProfile } from "./user";

export interface UserRepository {
  putUser(profile: UserProfile): Promise<void>;
  getUser(uid: string): Promise<UserProfile | null>;

  putUserBoard(uid: string, entry: UserBoardEntry): Promise<void>;
  getUserBoard(uid: string, boardId: string): Promise<UserBoardEntry | null>;
  listUserBoards(uid: string): Promise<UserBoardEntry[]>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryUserRepository implements UserRepository {
  private users = new Map<string, UserProfile>();
  private boards = new Map<string, Map<string, UserBoardEntry>>();

  async putUser(profile: UserProfile): Promise<void> {
    this.users.set(profile.uid, clone(profile));
  }

  async getUser(uid: string): Promise<UserProfile | null> {
    const profile = this.users.get(uid);
    return profile ? clone(profile) : null;
  }

  async putUserBoard(uid: string, entry: UserBoardEntry): Promise<void> {
    const byBoard = this.boards.get(uid) ?? new Map<string, UserBoardEntry>();
    byBoard.set(entry.boardId, clone(entry));
    this.boards.set(uid, byBoard);
  }

  async getUserBoard(uid: string, boardId: string): Promise<UserBoardEntry | null> {
    const entry = this.boards.get(uid)?.get(boardId);
    return entry ? clone(entry) : null;
  }

  async listUserBoards(uid: string): Promise<UserBoardEntry[]> {
    const entries = [...(this.boards.get(uid)?.values() ?? [])].map(clone);
    // Stable sort: claimedAt ties keep Map insertion (write) order.
    return entries.sort((a, b) => a.claimedAt - b.claimedAt);
  }
}
