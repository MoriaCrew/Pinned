import "server-only";
/**
 * Atomic daily AI budget counter (docs/11 section 5.2, PIN-61).
 *
 * One counter per UTC day tracks call count, reserved micro-USD and
 * per-participant / per-board counts. Reserve happens BEFORE the
 * provider call and fails closed: a denied or erroring reserve
 * means no call. The pure decision (`evaluateReserve`) is shared by
 * the in-memory store here and the Firestore store
 * (src/server/firestore-budget-store.ts, one doc/day updated with
 * FieldValue.increment inside a transaction), so both backends
 * enforce identical semantics. Money is integer micro-USD to avoid
 * float drift in counters.
 */

export function dayBucketFor(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface BudgetDayState {
  calls: number;
  reservedMicroUsd: number;
  participants: Record<string, number>;
  boards: Record<string, number>;
  /** Segmenter-only per-participant counts (PIN-92): kept apart from `participants` (photo/scene quotas) so SAM spend neither consumes nor is masked by those budgets. */
  participantSegments: Record<string, number>;
  /** Segmenter counts per photo (job id) for the day (PIN-92). */
  photos: Record<string, number>;
}

export function emptyBudgetDay(): BudgetDayState {
  return { calls: 0, reservedMicroUsd: 0, participants: {}, boards: {}, participantSegments: {}, photos: {} };
}

export interface ReserveRequest {
  dayBucket: string;
  estimatedCostUsd: number;
  /** Policy dailyBudgetUsd; 0 means OFF. */
  budgetUsd: number;
  /** Policy dailyCallLimit; 0 means OFF. */
  callLimit: number;
  participantId?: string;
  participantCap?: number;
  boardId?: string;
  boardCap?: number;
  /** Segmenter-only daily cap for participantId (PIN-92), counted in `participantSegments`, not `participants`. */
  participantSegmentCap?: number;
  /** Photo (job) id + Policy segmentsPerPhoto cap (PIN-92). */
  photoId?: string;
  photoCap?: number;
}

export type ReserveDenyReason =
  | "off"
  | "call_limit"
  | "budget"
  | "participant_cap"
  | "board_cap"
  | "photo_cap";

export type ReserveResult =
  | { ok: true; estimatedMicroUsd: number }
  | { ok: false; reason: ReserveDenyReason };

export function toMicroUsd(usd: number): number {
  return Math.max(0, Math.round(usd * 1_000_000));
}

/**
 * Pure check against a day state. Returns the micro-USD to add when
 * allowed; callers apply the increment atomically in their backend.
 */
export function evaluateReserve(
  state: BudgetDayState,
  request: ReserveRequest,
): ReserveResult {
  if (request.budgetUsd <= 0 || request.callLimit <= 0) {
    return { ok: false, reason: "off" };
  }
  if (state.calls + 1 > request.callLimit) {
    return { ok: false, reason: "call_limit" };
  }
  const estimatedMicroUsd = toMicroUsd(request.estimatedCostUsd);
  if (state.reservedMicroUsd + estimatedMicroUsd > toMicroUsd(request.budgetUsd)) {
    return { ok: false, reason: "budget" };
  }
  if (request.participantId && request.participantCap !== undefined) {
    if ((state.participants[request.participantId] ?? 0) >= request.participantCap) {
      return { ok: false, reason: "participant_cap" };
    }
  }
  if (request.boardId && request.boardCap !== undefined) {
    if ((state.boards[request.boardId] ?? 0) >= request.boardCap) {
      return { ok: false, reason: "board_cap" };
    }
  }
  if (request.participantId && request.participantSegmentCap !== undefined) {
    if ((state.participantSegments[request.participantId] ?? 0) >= request.participantSegmentCap) {
      return { ok: false, reason: "participant_cap" };
    }
  }
  if (request.photoId && request.photoCap !== undefined) {
    if ((state.photos[request.photoId] ?? 0) >= request.photoCap) {
      return { ok: false, reason: "photo_cap" };
    }
  }
  return { ok: true, estimatedMicroUsd };
}

/** Apply an allowed reservation to a state copy (Firestore create path). */
export function applyReserve(
  state: BudgetDayState,
  request: ReserveRequest,
  estimatedMicroUsd: number,
): BudgetDayState {
  const next: BudgetDayState = {
    calls: state.calls + 1,
    reservedMicroUsd: state.reservedMicroUsd + estimatedMicroUsd,
    participants: { ...state.participants },
    boards: { ...state.boards },
    participantSegments: { ...state.participantSegments },
    photos: { ...state.photos },
  };
  if (request.participantId && request.participantCap !== undefined) {
    next.participants[request.participantId] =
      (next.participants[request.participantId] ?? 0) + 1;
  }
  if (request.boardId && request.boardCap !== undefined) {
    next.boards[request.boardId] = (next.boards[request.boardId] ?? 0) + 1;
  }
  if (request.participantId && request.participantSegmentCap !== undefined) {
    next.participantSegments[request.participantId] =
      (next.participantSegments[request.participantId] ?? 0) + 1;
  }
  if (request.photoId && request.photoCap !== undefined) {
    next.photos[request.photoId] = (next.photos[request.photoId] ?? 0) + 1;
  }
  return next;
}

export interface BudgetStore {
  reserve(request: ReserveRequest): Promise<ReserveResult>;
}

/**
 * In-process store (memory backend + tests). The reserve body has
 * no awaits between read and write, so it runs to completion
 * synchronously, which is what makes it atomic in-process.
 */
export class InMemoryBudgetStore implements BudgetStore {
  private days = new Map<string, BudgetDayState>();

  async reserve(request: ReserveRequest): Promise<ReserveResult> {
    const state = this.days.get(request.dayBucket) ?? emptyBudgetDay();
    const result = evaluateReserve(state, request);
    if (!result.ok) return result;
    this.days.set(
      request.dayBucket,
      applyReserve(state, request, result.estimatedMicroUsd),
    );
    return result;
  }

  /** Test/debug view; not part of the BudgetStore contract. */
  snapshot(dayBucket: string): BudgetDayState {
    const state = this.days.get(dayBucket) ?? emptyBudgetDay();
    return structuredClone(state);
  }
}
