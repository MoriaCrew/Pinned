import "server-only";
/**
 * Firestore AI-call log store (PIN-29, narrowed in PIN-93).
 * Server-only: client Firestore access remains deny-all in
 * firestore.rules. Layout: aiCallLogs/{logId}. The games/chains
 * collections went with the legacy game routes that were their
 * only readers. All domain times stay epoch-ms numbers. Writes
 * strip undefined recursively because Firestore rejects undefined
 * field values. (The `GameRepository` name predates the Studio
 * pivot and is kept to avoid a repo-wide rename.)
 */
import { Firestore, type DocumentData } from "@google-cloud/firestore";
import type { GameRepository } from "../domain/repository";
import type { AiCallLog } from "../domain/types";

const AI_CALL_LOGS = "aiCallLogs";

function toFirestoreData<T extends object>(value: T): DocumentData {
  return JSON.parse(JSON.stringify(value)) as DocumentData;
}

export class FirestoreGameRepository implements GameRepository {
  constructor(private readonly db: Firestore) {}

  async appendAiCallLog(log: AiCallLog): Promise<void> {
    await this.db.collection(AI_CALL_LOGS).doc(log.id).set(toFirestoreData(log));
  }

  async listAiCallLogs(dayBucket: string): Promise<AiCallLog[]> {
    const snapshot = await this.db
      .collection(AI_CALL_LOGS)
      .where("dayBucket", "==", dayBucket)
      .get();
    return snapshot.docs.map((doc) => structuredClone(doc.data() as AiCallLog));
  }

  /** Release the underlying gRPC client in scripts and tests. */
  async close(): Promise<void> {
    await this.db.terminate();
  }
}

export interface FirestoreRepositoryOptions {
  projectId?: string | null;
  emulatorHost?: string | null;
}

export function createFirestoreGameRepository(
  options: FirestoreRepositoryOptions = {},
): FirestoreGameRepository {
  const db = options.emulatorHost
    ? new Firestore({
        projectId: options.projectId ?? undefined,
        host: options.emulatorHost,
        ssl: false,
      })
    : new Firestore({ projectId: options.projectId ?? undefined });
  return new FirestoreGameRepository(db);
}
