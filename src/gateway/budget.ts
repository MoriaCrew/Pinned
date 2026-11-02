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

/** PIN-240: UTC hour bucket, e.g. "2026-10-29T23" (inside one day bucket). */
export function hourBucketFor(now: number): string {
  return new Date(now).toISOString().slice(0, 13);
}

export function dayBucketFor(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface BudgetDayState {
  calls: number;
  reservedMicroUsd: number;
  /** ElementNamer per-participant photo counts (PIN-136): split from the former shared `participants` counter so photo and scene caps are independent. */
  participantPhotos: Record<string, number>;
  /** SceneComposer per-participant scene counts (PIN-136). */
  participantScenes: Record<string, number>;
  boards: Record<string, number>;
  /** Segmenter-only per-participant counts (PIN-92): kept apart from `participantPhotos`/`participantScenes` so SAM spend neither consumes nor is masked by those budgets. */
  participantSegments: Record<string, number>;
  /** TapNamer-only per-participant counts (PIN-117): kept apart from `participantPhotos` exactly like participantSegments, so tap naming neither consumes nor is masked by the photos-per-day budget. */
  participantTapNames: Record<string, number>;
  /** SpeechTranscriber-only per-participant counts (PIN-119): kept apart exactly like participantTapNames. */
  participantTranscriptions: Record<string, number>;
  /** PIN-240: current UTC hour bucket tracked in this day doc; "" = none yet / legacy doc. */
  hourBucket: string;
  /** PIN-240: micro-USD reserved inside `hourBucket`; resets when the hour rolls. */
  hourReservedMicroUsd: number;
  /** Segmenter counts per photo (job id) for the day (PIN-92). */
  photos: Record<string, number>;
}

export function emptyBudgetDay(): BudgetDayState {
  return { calls: 0, reservedMicroUsd: 0, participantPhotos: {}, participantScenes: {}, boards: {}, participantSegments: {}, participantTapNames: {}, participantTranscriptions: {}, hourBucket: "", hourReservedMicroUsd: 0, photos: {} };
}

export interface ReserveRequest {
  dayBucket: string;
  estimatedCostUsd: number;
  /** Policy dailyBudgetUsd; 0 means OFF. */
  budgetUsd: number;
  /** PIN-240: UTC hour bucket for this reserve (hourBucketFor); absent = no hour tracking (legacy callers/tests). */
  hourBucket?: string;
  /** PIN-240: Policy hourlyBudgetUsd sub-cap; undefined or 0 = off (daily cap only). */
  hourlyBudgetUsd?: number;
  /** Policy dailyCallLimit; 0 means OFF. */
  callLimit: number;
  participantId?: string;
  /** ElementNamer-only daily cap for participantId (PIN-136), counted in `participantPhotos`. */
  participantPhotoCap?: number;
  /** SceneComposer-only daily cap for participantId (PIN-136), counted in `participantScenes`. */
  participantSceneCap?: number;
  boardId?: string;
  boardCap?: number;
  /** Segmenter-only daily cap for participantId (PIN-92), counted in `participantSegments`, not `participantPhotos`. */
  participantSegmentCap?: number;
  /** TapNamer-only daily cap for participantId (PIN-117), counted in `participantTapNames`, not `participantPhotos`. */
  participantTapNameCap?: number;
  /** SpeechTranscriber-only daily cap for participantId (PIN-119), counted in `participantTranscriptions`. */
  participantTranscriptionCap?: number;
  /** Photo (job) id + Policy segmentsPerPhoto cap (PIN-92). */
  photoId?: string;
  photoCap?: number;
}

export type ReserveDenyReason =
  | "off"
  | "call_limit"
  | "budget"
  | "hourly_budget"
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
  // PIN-240: hourly sub-cap (opt-in). Spend from a stale hour
  // bucket counts as 0; the daily check above stays authoritative.
  if (request.hourBucket && request.hourlyBudgetUsd !== undefined && request.hourlyBudgetUsd > 0) {
    const hourReserved = state.hourBucket === request.hourBucket ? state.hourReservedMicroUsd : 0;
    if (hourReserved + estimatedMicroUsd > toMicroUsd(request.hourlyBudgetUsd)) {
      return { ok: false, reason: "hourly_budget" };
    }
  }
  if (request.participantId && request.participantPhotoCap !== undefined) {
    if ((state.participantPhotos[request.participantId] ?? 0) >= request.participantPhotoCap) {
      return { ok: false, reason: "participant_cap" };
    }
  }
  if (request.participantId && request.participantSceneCap !== undefined) {
    if ((state.participantScenes[request.participantId] ?? 0) >= request.participantSceneCap) {
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
  if (request.participantId && request.participantTapNameCap !== undefined) {
    if ((state.participantTapNames[request.participantId] ?? 0) >= request.participantTapNameCap) {
      return { ok: false, reason: "participant_cap" };
    }
  }
  if (request.participantId && request.participantTranscriptionCap !== undefined) {
    if ((state.participantTranscriptions[request.participantId] ?? 0) >= request.participantTranscriptionCap) {
      return { ok: false, reason: "participant_cap" };
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
    participantPhotos: { ...state.participantPhotos },
    participantScenes: { ...state.participantScenes },
    boards: { ...state.boards },
    participantSegments: { ...state.participantSegments },
    participantTapNames: { ...state.participantTapNames },
    participantTranscriptions: { ...state.participantTranscriptions },
    hourBucket: request.hourBucket ?? state.hourBucket,
    hourReservedMicroUsd: !request.hourBucket
      ? state.hourReservedMicroUsd
      : state.hourBucket === request.hourBucket
        ? state.hourReservedMicroUsd + estimatedMicroUsd
        : estimatedMicroUsd,
    photos: { ...state.photos },
  };
  if (request.participantId && request.participantPhotoCap !== undefined) {
    next.participantPhotos[request.participantId] =
      (next.participantPhotos[request.participantId] ?? 0) + 1;
  }
  if (request.participantId && request.participantSceneCap !== undefined) {
    next.participantScenes[request.participantId] =
      (next.participantScenes[request.participantId] ?? 0) + 1;
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
  if (request.participantId && request.participantTapNameCap !== undefined) {
    next.participantTapNames[request.participantId] =
      (next.participantTapNames[request.participantId] ?? 0) + 1;
  }
  if (request.participantId && request.participantTranscriptionCap !== undefined) {
    next.participantTranscriptions[request.participantId] =
      (next.participantTranscriptions[request.participantId] ?? 0) + 1;
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
