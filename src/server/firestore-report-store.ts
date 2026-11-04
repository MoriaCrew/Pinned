import "server-only";
/**
 * Firestore ReportStore (PIN-269): one doc per report at
 * `reports/{id}`. Server-only; client rules stay deny-all. The board
 * slug (`boardId`) lives in the doc and nowhere else: alerts, receipts
 * and the operator scripts carry the opaque `reference`.
 *
 * `dueAt` is the backstop's query key: a mirror of `deleteAt` present
 * only while the report is open (`decide` drops it), so
 * `listOpenDue` is one single-field range query with no composite
 * index, and a decided report never comes back as due (the
 * demoSweepAt pattern of PIN-251). It is stripped on every read.
 */
import { Firestore, type DocumentData } from "@google-cloud/firestore";
import type { ReportRecord } from "../domain/board-report";
import type { ReportDecision, ReportStore } from "../domain/report-store";
import { toFirestoreData } from "./firestore-util";

const REPORTS = "reports";

function fromData(data: DocumentData | undefined): ReportRecord | null {
  if (!data) return null;
  const { dueAt: _due, ...rest } = structuredClone(data);
  return rest as unknown as ReportRecord;
}

function toData(record: ReportRecord): DocumentData {
  const data = toFirestoreData(record);
  return record.status === "open" && record.deleteAt !== undefined ? { ...data, dueAt: record.deleteAt } : data;
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

export class FirestoreReportStore implements ReportStore {
  constructor(private readonly db: Firestore) {}

  private ref(id: string) {
    return this.db.collection(REPORTS).doc(id);
  }

  async create(record: ReportRecord): Promise<void> {
    try {
      await this.ref(record.id).create(toData(record));
    } catch (error) {
      if (isAlreadyExists(error)) throw new RangeError(`Report ${record.id} already exists`);
      throw error;
    }
  }

  async get(id: string): Promise<ReportRecord | null> {
    return fromData((await this.ref(id).get()).data());
  }

  async listByReference(reference: string): Promise<ReportRecord[]> {
    const snap = await this.db.collection(REPORTS).where("reference", "==", reference).get();
    return snap.docs
      .map((doc) => fromData(doc.data()))
      .filter((record): record is ReportRecord => record !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async listOpenForBoard(boardId: string): Promise<ReportRecord[]> {
    const snap = await this.db.collection(REPORTS).where("boardId", "==", boardId).get();
    return snap.docs
      .map((doc) => fromData(doc.data()))
      .filter((record): record is ReportRecord => record !== null && record.status === "open")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async listOpenDue(before: number, limit: number): Promise<ReportRecord[]> {
    if (limit <= 0) return [];
    const snap = await this.db
      .collection(REPORTS)
      .where("dueAt", "<", before)
      .orderBy("dueAt")
      .limit(limit)
      .get();
    return snap.docs
      .map((doc) => fromData(doc.data()))
      .filter((record): record is ReportRecord => record !== null && record.status === "open");
  }

  async decide(id: string, decision: ReportDecision): Promise<ReportRecord | null> {
    const ref = this.ref(id);
    return this.db.runTransaction(async (tx) => {
      const current = fromData((await tx.get(ref)).data());
      if (!current || current.status !== "open") return null;
      const decided: ReportRecord = {
        ...current,
        status: decision.status,
        decidedAt: decision.decidedAt,
        ...(decision.note !== undefined ? { note: decision.note } : {}),
      };
      tx.set(ref, toData(decided));
      return structuredClone(decided);
    });
  }
}

export interface FirestoreReportStoreOptions {
  projectId?: string | null;
  emulatorHost?: string | null;
}

export function createFirestoreReportStore(options: FirestoreReportStoreOptions = {}): FirestoreReportStore {
  const db = options.emulatorHost
    ? new Firestore({
        projectId: options.projectId ?? undefined,
        host: options.emulatorHost,
        ssl: false,
      })
    : new Firestore({ projectId: options.projectId ?? undefined });
  return new FirestoreReportStore(db);
}
