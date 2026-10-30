import "server-only";
/**
 * Firestore BudgetStore (PIN-61): ONE counter doc per UTC day at
 * aiBudget/{dayBucket}. Reserve runs in a transaction — read the
 * doc, run the shared pure check (src/gateway/budget.ts), then
 * apply FieldValue.increment writes — so two concurrent reserves
 * at the cap cannot both proceed (Firestore retries the loser,
 * which then re-reads and is denied). Semantics match
 * InMemoryBudgetStore by construction.
 */
import {
  FieldValue,
  Firestore,
  type DocumentData,
} from "@google-cloud/firestore";
import {
  applyReserve,
  emptyBudgetDay,
  evaluateReserve,
  type BudgetDayState,
  type BudgetStore,
  type ReserveRequest,
  type ReserveResult,
} from "../gateway/budget";

const AI_BUDGET = "aiBudget";

function numRecord(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function stateFrom(data: DocumentData | undefined): BudgetDayState {
  if (!data) return emptyBudgetDay();
  return {
    calls: typeof data.calls === "number" ? data.calls : 0,
    reservedMicroUsd:
      typeof data.reservedMicroUsd === "number" ? data.reservedMicroUsd : 0,
    participants: numRecord(data.participants),
    boards: numRecord(data.boards),
    participantSegments: numRecord(data.participantSegments),
    participantTapNames: numRecord(data.participantTapNames),
    participantTranscriptions: numRecord(data.participantTranscriptions),
    photos: numRecord(data.photos),
  };
}

export class FirestoreBudgetStore implements BudgetStore {
  constructor(private readonly db: Firestore) {}

  async reserve(request: ReserveRequest): Promise<ReserveResult> {
    const ref = this.db.collection(AI_BUDGET).doc(request.dayBucket);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const state = stateFrom(snapshot.exists ? snapshot.data() : undefined);
      const result = evaluateReserve(state, request);
      if (!result.ok) return result;
      if (!snapshot.exists) {
        transaction.set(ref, {
          dayBucket: request.dayBucket,
          ...applyReserve(state, request, result.estimatedMicroUsd),
        });
        return result;
      }
      const updates: DocumentData = {
        calls: FieldValue.increment(1),
        reservedMicroUsd: FieldValue.increment(result.estimatedMicroUsd),
      };
      if (request.participantId && request.participantCap !== undefined) {
        updates[`participants.${request.participantId}`] =
          FieldValue.increment(1);
      }
      if (request.boardId && request.boardCap !== undefined) {
        updates[`boards.${request.boardId}`] = FieldValue.increment(1);
      }
      if (request.participantId && request.participantSegmentCap !== undefined) {
        updates[`participantSegments.${request.participantId}`] =
          FieldValue.increment(1);
      }
      if (request.photoId && request.photoCap !== undefined) {
        updates[`photos.${request.photoId}`] = FieldValue.increment(1);
      }
      if (request.participantId && request.participantTranscriptionCap !== undefined) {
        updates[`participantTranscriptions.${request.participantId}`] =
          FieldValue.increment(1);
      }
      if (request.participantId && request.participantTapNameCap !== undefined) {
        updates[`participantTapNames.${request.participantId}`] =
          FieldValue.increment(1);
      }
      transaction.update(ref, updates);
      return result;
    });
  }
}

export interface FirestoreBudgetStoreOptions {
  projectId?: string | null;
  emulatorHost?: string | null;
}

export function createFirestoreBudgetStore(
  options: FirestoreBudgetStoreOptions = {},
): FirestoreBudgetStore {
  const db = options.emulatorHost
    ? new Firestore({
        projectId: options.projectId ?? undefined,
        host: options.emulatorHost,
        ssl: false,
      })
    : new Firestore({ projectId: options.projectId ?? undefined });
  return new FirestoreBudgetStore(db);
}
