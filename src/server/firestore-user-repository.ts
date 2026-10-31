import "server-only";
/**
 * Firestore UserRepository (PIN-83, docs/11 section 5.4).
 * Server-only: client Firestore access stays deny-all in
 * firestore.rules. Passes the shared suite in
 * user-repository.contract.ts against a fake Firestore.
 *
 * Layout: users/{uid} profile docs + users/{uid}/boards/{slug}
 * index docs. Reads are doc-get / whole-subcollection only, with
 * sorting in code over the small per-user set — NO new Firestore
 * index. Index docs carry an internal `_seq` (write order within
 * the user's boards) so claimedAt ties keep write order exactly
 * like the in-memory implementation; `_seq` is stripped on read.
 * Writes strip undefined via JSON round-trip (Firestore rejects
 * undefined), which also deep-clones caller input.
 */
import {
  Firestore,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type QuerySnapshot,
} from "@google-cloud/firestore";
import type { UserBoardEntry, UserProfile } from "../domain/user";
import type { UserRepository } from "../domain/user-repository";
import { toFirestoreData } from "./firestore-util";

const USERS = "users";
const BOARDS = "boards";

interface StoredRow<T> {
  value: T;
  seq: number;
}

function rowFrom<T>(data: DocumentData): StoredRow<T> {
  const { _seq, ...rest } = structuredClone(data);
  return { value: rest as unknown as T, seq: typeof _seq === "number" ? _seq : 0 };
}

function rowsFrom<T>(snapshot: QuerySnapshot): StoredRow<T>[] {
  return snapshot.docs.map((doc) => rowFrom<T>(doc.data()));
}

function fromSnapshot<T>(snapshot: DocumentSnapshot): T | null {
  if (!snapshot.exists) return null;
  return rowFrom<T>(snapshot.data() as DocumentData).value;
}

export class FirestoreUserRepository implements UserRepository {
  constructor(private readonly db: Firestore) {}

  private userRef(uid: string): DocumentReference {
    return this.db.collection(USERS).doc(uid);
  }

  private boardsCol(uid: string): CollectionReference {
    return this.userRef(uid).collection(BOARDS);
  }

  async putUser(profile: UserProfile): Promise<void> {
    await this.userRef(profile.uid).set(toFirestoreData(profile));
  }

  async getUser(uid: string): Promise<UserProfile | null> {
    return fromSnapshot<UserProfile>(await this.userRef(uid).get());
  }

  async putUserBoard(uid: string, entry: UserBoardEntry): Promise<void> {
    const ref = this.boardsCol(uid).doc(entry.boardId);
    const existing = await ref.get();
    if (existing.exists) {
      const seq = rowFrom<UserBoardEntry>(existing.data() as DocumentData).seq;
      await ref.set({ ...toFirestoreData(entry), _seq: seq });
      return;
    }
    const rows = rowsFrom<UserBoardEntry>(await this.boardsCol(uid).get());
    const seq = rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
    await ref.set({ ...toFirestoreData(entry), _seq: seq });
  }

  async getUserBoard(uid: string, boardId: string): Promise<UserBoardEntry | null> {
    return fromSnapshot<UserBoardEntry>(await this.boardsCol(uid).doc(boardId).get());
  }

  async listUserBoards(uid: string): Promise<UserBoardEntry[]> {
    const rows = rowsFrom<UserBoardEntry>(await this.boardsCol(uid).get());
    return [...rows]
      .sort((a, b) => a.value.claimedAt - b.value.claimedAt || a.seq - b.seq)
      .map((row) => row.value);
  }

  /** Idempotent: Firestore delete of a missing doc succeeds. */
  async deleteUserBoard(uid: string, boardId: string): Promise<void> {
    await this.boardsCol(uid).doc(boardId).delete();
  }

  /** Release the underlying gRPC client in scripts and tests. */
  async close(): Promise<void> {
    await this.db.terminate();
  }
}

export interface FirestoreUserRepositoryOptions {
  projectId?: string | null;
  emulatorHost?: string | null;
}

export function createFirestoreUserRepository(
  options: FirestoreUserRepositoryOptions = {},
): FirestoreUserRepository {
  const db = options.emulatorHost
    ? new Firestore({
        projectId: options.projectId ?? undefined,
        host: options.emulatorHost,
        ssl: false,
      })
    : new Firestore({ projectId: options.projectId ?? undefined });
  return new FirestoreUserRepository(db);
}
