/**
 * New-join rate math (PIN-91). Pure and Policy-fed, mirroring
 * reclaim-lockout.ts: this module only decides how a counter state
 * evolves; the BoardRepository stores it (Firestore across
 * instances) and applies the decision atomically.
 *
 * Only NEW participant creations are counted — updates, reclaims
 * and restores of existing roster members never reach this module,
 * so a family behind one NAT IP can rename/rejoin freely; the
 * budget bounds how fast one connection can mint fresh roster
 * entries (the roster-fill DoS vector).
 */

export interface JoinRateParams {
  /** New participants allowed per key within one window. */
  maxJoins: number;
  /** Fixed-window length in ms, anchored at the first join. */
  windowMs: number;
}

export interface JoinAttemptState {
  boardId: string;
  /** Opaque, caller-hashed counter key (never a raw IP). */
  key: string;
  joins: number;
  windowStartedAt: number;
  lastJoinAt: number;
}

export interface JoinDecision {
  allowed: boolean;
  /** State to store when allowed; null = store nothing (denied). */
  next: JoinAttemptState | null;
}

/**
 * Decide one new join at `now`. A denied join records nothing, so
 * retrying cannot extend the window — the budget refills exactly
 * `windowMs` after the window's first join.
 */
export function decideJoin(
  boardId: string,
  key: string,
  current: JoinAttemptState | null,
  now: number,
  params: JoinRateParams,
): JoinDecision {
  if (!current || now - current.windowStartedAt >= params.windowMs) {
    return {
      allowed: params.maxJoins >= 1,
      next:
        params.maxJoins >= 1
          ? { boardId, key, joins: 1, windowStartedAt: now, lastJoinAt: now }
          : null,
    };
  }
  if (current.joins >= params.maxJoins) return { allowed: false, next: null };
  return {
    allowed: true,
    next: { ...current, joins: current.joins + 1, lastJoinAt: now },
  };
}
