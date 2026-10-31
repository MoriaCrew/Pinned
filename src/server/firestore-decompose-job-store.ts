import "server-only";
/**
 * Firestore DecomposeJobStore (PIN-65, docs/11 section 5.3).
 * Layout reserved by PIN-63: boards/{slug}/jobs/{jobId}. Job ids
 * are globally unique while storage is per-board, so id-only
 * lookups use a collection-group query on `id` (field override in
 * firestore.indexes.json; operator deploys indexes before hosted
 * board traffic, same note as firestore-board-repository.ts).
 * Claim is a transaction: only the caller that flips
 * pending -> running wins (claim-before-call).
 */
import {
  Firestore,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
  type Transaction,
} from "@google-cloud/firestore";
import type { DecomposeJob } from "../domain/board";
import type { DecomposeJobStore } from "./decompose-job";

const BOARDS = "boards";
const JOBS = "jobs";

function toFirestoreData(job: DecomposeJob): DocumentData {
  return JSON.parse(JSON.stringify(job)) as DocumentData;
}

function fromSnapshot(snapshot: DocumentSnapshot): DecomposeJob | null {
  if (!snapshot.exists) return null;
  return structuredClone(snapshot.data() as DocumentData) as unknown as DecomposeJob;
}

function isAlreadyExists(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === 6 ||
    candidate.code === "already-exists" ||
    (typeof candidate.message === "string" && /already exists/i.test(candidate.message))
  );
}

export class FirestoreDecomposeJobStore implements DecomposeJobStore {
  constructor(private readonly db: Firestore) {}

  private jobRef(boardId: string, jobId: string): DocumentReference {
    return this.db.collection(BOARDS).doc(boardId).collection(JOBS).doc(jobId);
  }

  private async findRef(jobId: string): Promise<DocumentReference | null> {
    const snap = await this.db.collectionGroup(JOBS).where("id", "==", jobId).get();
    return snap.docs[0]?.ref ?? null;
  }

  private async txFindRef(tx: Transaction, jobId: string): Promise<DocumentReference | null> {
    const query: Query = this.db.collectionGroup(JOBS).where("id", "==", jobId);
    const snap = await tx.get(query);
    return snap.docs[0]?.ref ?? null;
  }

  async create(job: DecomposeJob): Promise<void> {
    try {
      await this.jobRef(job.boardId, job.id).create(toFirestoreData(job));
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new RangeError(`DecomposeJob ${job.id} already exists`);
      }
      throw error;
    }
  }

  async deleteIfUntouched(jobId: string, createdAt: number): Promise<boolean> {
    const ref = await this.findRef(jobId);
    if (!ref) return false;
    return this.db.runTransaction(async (tx) => {
      const job = fromSnapshot(await tx.get(ref));
      if (!job || job.status !== "pending" || job.updatedAt !== createdAt) return false;
      tx.delete(ref);
      return true;
    });
  }

  async get(jobId: string): Promise<DecomposeJob | null> {
    const ref = await this.findRef(jobId);
    if (!ref) return null;
    return fromSnapshot(await ref.get());
  }

  async claim(jobId: string, now: number): Promise<DecomposeJob | null> {
    const ref = await this.findRef(jobId);
    if (!ref) return null;
    return this.db.runTransaction(async (tx) => {
      const job = fromSnapshot(await tx.get(ref));
      if (!job || job.status !== "pending") return null;
      const claimed: DecomposeJob = { ...job, status: "running", updatedAt: now };
      tx.set(ref, toFirestoreData(claimed));
      return structuredClone(claimed);
    });
  }

  async update(job: DecomposeJob): Promise<void> {
    const ref = this.jobRef(job.boardId, job.id);
    await this.db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (!existing.exists) {
        // Fall back to the id lookup in case boardId drifted; the
        // port contract is "missing job throws RangeError".
        const found = await this.txFindRef(tx, job.id);
        if (!found) throw new RangeError(`DecomposeJob ${job.id} not found`);
        tx.set(found, toFirestoreData(job));
        return;
      }
      tx.set(ref, toFirestoreData(job));
    });
  }

  async listForBoard(boardId: string): Promise<DecomposeJob[]> {
    const snap = await this.db
      .collection(BOARDS)
      .doc(boardId)
      .collection(JOBS)
      .get();
    return snap.docs
      .map((doc) => structuredClone(doc.data()) as unknown as DecomposeJob)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Release the underlying gRPC client in scripts and tests. */
  async close(): Promise<void> {
    await this.db.terminate();
  }
}

export interface FirestoreDecomposeJobStoreOptions {
  projectId?: string | null;
  emulatorHost?: string | null;
}

export function createFirestoreDecomposeJobStore(
  options: FirestoreDecomposeJobStoreOptions = {},
): FirestoreDecomposeJobStore {
  const db = options.emulatorHost
    ? new Firestore({
        projectId: options.projectId ?? undefined,
        host: options.emulatorHost,
        ssl: false,
      })
    : new Firestore({ projectId: options.projectId ?? undefined });
  return new FirestoreDecomposeJobStore(db);
}
