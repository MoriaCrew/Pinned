/**
 * ReportStore port (PIN-269, ADR-004): the `reports/{id}` records
 * behind the in-app report route, the operator's decide script and
 * the timed-takedown backstop. The in-memory implementation is the
 * test double and the contract (`report-store.contract.ts`); the
 * Firestore one (`src/server/firestore-report-store.ts`) passes the
 * same suite.
 *
 * Contract: reads return isolated copies and writes store copies; a
 * duplicate id throws RangeError; `listOpenDue` sees only open reports
 * that carry a deadline, oldest deadline first; `decide` closes an open
 * report exactly once (a second decision, or a missing id, is null).
 */
import type { ReportRecord, ReportStatus } from "./board-report";

export interface ReportDecision {
  status: Exclude<ReportStatus, "open">;
  decidedAt: number;
  /** Operator note; never a slug. */
  note?: string;
}

export interface ReportStore {
  create(record: ReportRecord): Promise<void>;
  get(id: string): Promise<ReportRecord | null>;
  /** Every report carrying this reference (one board), newest first. */
  listByReference(reference: string): Promise<ReportRecord[]>;
  /** Open reports on one board, oldest first. */
  listOpenForBoard(boardId: string): Promise<ReportRecord[]>;
  /** Every report on one board, any status, oldest first (the holds a release must respect). */
  listForBoard(boardId: string): Promise<ReportRecord[]>;
  /** Open reports across boards for the operator's queue, oldest first, at most `limit`. */
  listOpen(limit: number): Promise<ReportRecord[]>;
  /** Open reports whose `deleteAt` is before `before`, oldest deadline first, at most `limit`. */
  listOpenDue(before: number, limit: number): Promise<ReportRecord[]>;
  /** Close an open report; null when missing or already decided. */
  decide(id: string, decision: ReportDecision): Promise<ReportRecord | null>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryReportStore implements ReportStore {
  private readonly records = new Map<string, ReportRecord>();

  async create(record: ReportRecord): Promise<void> {
    if (this.records.has(record.id)) throw new RangeError(`Report ${record.id} already exists`);
    this.records.set(record.id, clone(record));
  }

  async get(id: string): Promise<ReportRecord | null> {
    const hit = this.records.get(id);
    return hit ? clone(hit) : null;
  }

  async listByReference(reference: string): Promise<ReportRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.reference === reference)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }

  async listOpenForBoard(boardId: string): Promise<ReportRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.boardId === boardId && record.status === "open")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(clone);
  }

  async listForBoard(boardId: string): Promise<ReportRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.boardId === boardId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(clone);
  }

  async listOpen(limit: number): Promise<ReportRecord[]> {
    if (limit <= 0) return [];
    return [...this.records.values()]
      .filter((record) => record.status === "open")
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map(clone);
  }

  async listOpenDue(before: number, limit: number): Promise<ReportRecord[]> {
    if (limit <= 0) return [];
    return [...this.records.values()]
      .filter(
        (record): record is ReportRecord & { deleteAt: number } =>
          record.status === "open" && record.deleteAt !== undefined && record.deleteAt < before,
      )
      .sort((a, b) => a.deleteAt - b.deleteAt)
      .slice(0, limit)
      .map(clone);
  }

  async decide(id: string, decision: ReportDecision): Promise<ReportRecord | null> {
    const current = this.records.get(id);
    if (!current || current.status !== "open") return null;
    const decided: ReportRecord = {
      ...clone(current),
      status: decision.status,
      decidedAt: decision.decidedAt,
      ...(decision.note !== undefined ? { note: decision.note } : {}),
    };
    this.records.set(id, decided);
    return clone(decided);
  }
}
