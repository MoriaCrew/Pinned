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
import { Firestore, Timestamp } from "@google-cloud/firestore";
import type { GameRepository } from "../domain/repository";
import { normalizeAiCallLog, type AiCallLog } from "../domain/types";
import { toFirestoreData } from "./firestore-util";

const AI_CALL_LOGS = "aiCallLogs";

export class FirestoreGameRepository implements GameRepository {
  constructor(private readonly db: Firestore) {}

  async appendAiCallLog(log: AiCallLog): Promise<void> {
    // PIN-137: expireAtTs mirrors expireAt as a Firestore Timestamp
    // so the operator can enable a TTL policy on it console-side
    // (Firestore TTL requires a timestamp field). The TTL policy
    // itself is NOT created here; readers strip this helper field.
    const data = toFirestoreData(log);
    if (typeof log.expireAt === "number") {
      data.expireAtTs = Timestamp.fromMillis(log.expireAt);
    }
    await this.db.collection(AI_CALL_LOGS).doc(log.id).set(data);
  }

  async listAiCallLogs(dayBucket: string): Promise<AiCallLog[]> {
    const snapshot = await this.db
      .collection(AI_CALL_LOGS)
      .where("dayBucket", "==", dayBucket)
      .get();
    return snapshot.docs.map((doc) => {
      const raw = { ...(doc.data() as AiCallLog & { expireAtTs?: unknown }) };
      delete raw.expireAtTs;
      return normalizeAiCallLog(structuredClone(raw));
    });
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
