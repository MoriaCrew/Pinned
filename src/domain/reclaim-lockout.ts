/**
 * Reclaim-PIN lockout math (PIN-90). Pure and Policy-fed: every
 * threshold/window comes in via parameters, so the server layer and
 * tests share exactly one definition. Attempt state lives in the
 * BoardRepository (Firestore across instances); this module only
 * decides how a state evolves.
 */

export interface ReclaimLockoutParams {
  /** Failures that trigger a lock. */
  maxFailures: number;
  /** Idle time after which an unlocked counter decays to fresh. */
  failureWindowMs: number;
  /** First lock duration; each further failure doubles it. */
  lockoutBaseMs: number;
  /** Cap on the lock duration. */
  lockoutMaxMs: number;
}

export interface ReclaimAttemptState {
  boardId: string;
  /** Opaque, caller-hashed counter key (never a raw name or IP). */
  key: string;
  failures: number;
  firstFailureAt: number;
  lastFailureAt: number;
  /** Epoch ms until which reclaims are refused; 0 = not locked. */
  lockedUntil: number;
}

/** True while the lock is still running at `now`. */
export function isReclaimLocked(
  state: ReclaimAttemptState | null,
  now: number,
): boolean {
  return state !== null && state.lockedUntil > now;
}

/**
 * Drop stale state: once a lock has expired AND the failure window
 * has passed since the last failure, the counter starts fresh.
 */
export function freshReclaimState(
  state: ReclaimAttemptState | null,
  now: number,
  params: ReclaimLockoutParams,
): ReclaimAttemptState | null {
  if (!state) return null;
  if (isReclaimLocked(state, now)) return state;
  if (now - state.lastFailureAt >= params.failureWindowMs) return null;
  return state;
}

function lockDurationMs(failures: number, params: ReclaimLockoutParams): number {
  if (failures < params.maxFailures) return 0;
  const exponent = Math.min(failures - params.maxFailures, 32);
  return Math.min(params.lockoutMaxMs, params.lockoutBaseMs * 2 ** exponent);
}

/** Next state after one more failed attempt at `now`. */
export function recordReclaimFailure(
  boardId: string,
  key: string,
  current: ReclaimAttemptState | null,
  now: number,
  params: ReclaimLockoutParams,
): ReclaimAttemptState {
  const base = freshReclaimState(current, now, params);
  const failures = (base?.failures ?? 0) + 1;
  const lockMs = lockDurationMs(failures, params);
  return {
    boardId,
    key,
    failures,
    firstFailureAt: base?.firstFailureAt ?? now,
    lastFailureAt: now,
    lockedUntil: lockMs > 0 ? now + lockMs : 0,
  };
}
