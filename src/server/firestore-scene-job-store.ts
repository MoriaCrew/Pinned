import "server-only";
/**
 * Firestore SceneJobStore (PIN-69, docs/11 section 5.3).
 * Layout: boards/{slug}/sceneJobs/{jobId} (kept apart from the
 * DecomposeJob `jobs/` subcollection so neither store's board
 * listing ever mixes shapes). Every call is board-scoped — direct
 * doc refs and one subcollection read — so NO collection-group
 * query and NO new Firestore index are needed. Claim is a
 * transaction: only the caller that flips pending -> running
 * wins (claim-before-call).
 */
import {
  Firestore,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
} from "@google-cloud/firestore";
import type { SceneJob } from "../domain/board";
import type { SceneJobStore } from "./scene-job";
import { toFirestoreData } from "./firestore-util";

const BOARDS = "boards";
const SCENE_JOBS = "sceneJobs";

function fromSnapshot(snapshot: DocumentSnapshot): SceneJob | null {
  if (!snapshot.exists) return null;
  return structuredClone(snapshot.data() as DocumentData) as unknown as SceneJob;
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

export class FirestoreSceneJobStore implements SceneJobStore {
  constructor(private readonly db: Firestore) {}

  private jobRef(boardId: string, jobId: string): DocumentReference {
    return this.db
      .collection(BOARDS)
      .doc(boardId)
      .collection(SCENE_JOBS)
      .doc(jobId);
  }

  async create(job: SceneJob): Promise<void> {
    try {
      await this.jobRef(job.boardId, job.id).create(toFirestoreData(job));
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new RangeError(`SceneJob ${job.id} already exists`);
      }
      throw error;
    }
  }

  async get(boardId: string, jobId: string): Promise<SceneJob | null> {
    return fromSnapshot(await this.jobRef(boardId, jobId).get());
  }

  async claim(
    boardId: string,
    jobId: string,
    now: number,
  ): Promise<SceneJob | null> {
    const ref = this.jobRef(boardId, jobId);
    return this.db.runTransaction(async (tx) => {
      const job = fromSnapshot(await tx.get(ref));
      if (!job || job.status !== "pending") return null;
      const claimed: SceneJob = { ...job, status: "running", updatedAt: now };
      tx.set(ref, toFirestoreData(claimed));
      return structuredClone(claimed);
    });
  }

  async update(job: SceneJob): Promise<void> {
    const ref = this.jobRef(job.boardId, job.id);
    await this.db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (!existing.exists) {
        throw new RangeError(`SceneJob ${job.id} not found`);
      }
      tx.set(ref, toFirestoreData(job));
    });
  }

  async listForBoard(boardId: string): Promise<SceneJob[]> {
    const snap = await this.db
      .collection(BOARDS)
      .doc(boardId)
      .collection(SCENE_JOBS)
      .get();
    return snap.docs
      .map((doc) => structuredClone(doc.data()) as unknown as SceneJob)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Release the underlying gRPC client in scripts and tests. */
  async close(): Promise<void> {
    await this.db.terminate();
  }
}

export interface FirestoreSceneJobStoreOptions {
  projectId?: string | null;
  emulatorHost?: string | null;
}

export function createFirestoreSceneJobStore(
  options: FirestoreSceneJobStoreOptions = {},
): FirestoreSceneJobStore {
  const db = options.emulatorHost
    ? new Firestore({
        projectId: options.projectId ?? undefined,
        host: options.emulatorHost,
        ssl: false,
      })
    : new Firestore({ projectId: options.projectId ?? undefined });
  return new FirestoreSceneJobStore(db);
}
