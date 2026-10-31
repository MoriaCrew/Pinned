/**
 * Free creations per maker (PIN-204, docs/15 "Free creations
 * rule"). The board starter pool (Policy.credits.starterMakes) is
 * a welcome gift per maker, not per board: only a maker's first
 * `maxBoards` new boards per window get it. This module decides
 * how one maker's counter evolves; the StarterAllowanceStore keeps
 * it (Firestore across instances) and applies the decision
 * atomically. Pure and Policy-fed, mirroring join-rate.ts.
 *
 * The key is opaque and hashed by the caller (a signed-in user or
 * a client address, never stored raw). `expireAt` is the window's
 * end, so a Firestore TTL policy can drop stale counters.
 */

export interface StarterAllowanceParams {
  /** Boards per maker that get the starter pool within one window (Policy credits.starterBoardsPerMaker). */
  maxBoards: number;
  /** Fixed-window length in ms, anchored at the first counted board (Policy credits.starterMakerWindowMs). */
  windowMs: number;
}

export interface StarterAllowanceState {
  /** Opaque, caller-hashed maker key (never a raw IP or user id). */
  key: string;
  boards: number;
  windowStartedAt: number;
  lastBoardAt: number;
  /** windowStartedAt + windowMs: the counter means nothing after it. */
  expireAt: number;
}

export interface StarterAllowanceDecision {
  allowed: boolean;
  /** State to store when allowed; null = store nothing (denied). */
  next: StarterAllowanceState | null;
}

/**
 * Decide one new board at `now`. A denied claim records nothing,
 * so creating more boards cannot extend the window: it refills
 * exactly `windowMs` after the window's first counted board.
 */
export function decideStarterSlot(
  key: string,
  current: StarterAllowanceState | null,
  now: number,
  params: StarterAllowanceParams,
): StarterAllowanceDecision {
  if (!current || now - current.windowStartedAt >= params.windowMs) {
    if (params.maxBoards < 1) return { allowed: false, next: null };
    return {
      allowed: true,
      next: {
        key,
        boards: 1,
        windowStartedAt: now,
        lastBoardAt: now,
        expireAt: now + params.windowMs,
      },
    };
  }
  if (current.boards >= params.maxBoards) return { allowed: false, next: null };
  return {
    allowed: true,
    next: { ...current, boards: current.boards + 1, lastBoardAt: now },
  };
}

/**
 * Where maker counters live. `tryClaim` checks and records one
 * board atomically: true = this board gets the starter pool.
 */
export interface StarterAllowanceStore {
  tryClaim(key: string, now: number, params: StarterAllowanceParams): Promise<boolean>;
}

export function assertMakerKey(key: string): void {
  if (typeof key !== "string" || !key.trim() || key.includes("/")) {
    throw new RangeError("maker key must be a non-empty string without '/'");
  }
}

/** In-process store (memory backend + tests). No await between read and write, so each claim is atomic. */
export class InMemoryStarterAllowanceStore implements StarterAllowanceStore {
  private readonly counters = new Map<string, StarterAllowanceState>();

  async tryClaim(key: string, now: number, params: StarterAllowanceParams): Promise<boolean> {
    assertMakerKey(key);
    const current = this.counters.get(key);
    const decision = decideStarterSlot(key, current ? structuredClone(current) : null, now, params);
    if (!decision.allowed || decision.next === null) return false;
    this.counters.set(key, decision.next);
    return true;
  }
}
