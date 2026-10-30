import { describe, expect, it } from "vitest";
import { decideJoin, type JoinAttemptState } from "./join-rate";

const PARAMS = { maxJoins: 3, windowMs: 60_000 };

describe("decideJoin (PIN-91)", () => {
  it("allows up to maxJoins in a window, then denies without recording", () => {
    let state: JoinAttemptState | null = null;
    for (const t of [1_000, 2_000, 3_000]) {
      const decision = decideJoin("board", "key", state, t, PARAMS);
      expect(decision.allowed).toBe(true);
      state = decision.next;
    }
    expect(state).toMatchObject({ joins: 3, windowStartedAt: 1_000, lastJoinAt: 3_000 });

    const denied = decideJoin("board", "key", state, 4_000, PARAMS);
    expect(denied).toEqual({ allowed: false, next: null });
    // Repeated denials do not move the window anchor: the budget
    // still refills 60s after the first join, not after denials.
    const refilled = decideJoin("board", "key", state, 61_000, PARAMS);
    expect(refilled.allowed).toBe(true);
    expect(refilled.next).toMatchObject({ joins: 1, windowStartedAt: 61_000 });
  });

  it("denies one ms before the window rolls", () => {
    const state: JoinAttemptState = {
      boardId: "board",
      key: "key",
      joins: 3,
      windowStartedAt: 1_000,
      lastJoinAt: 2_000,
    };
    expect(decideJoin("board", "key", state, 60_999, PARAMS).allowed).toBe(false);
    expect(decideJoin("board", "key", state, 61_000, PARAMS).allowed).toBe(true);
  });

  it("a zero budget denies everything and stores nothing", () => {
    expect(decideJoin("board", "key", null, 1_000, { maxJoins: 0, windowMs: 60_000 }))
      .toEqual({ allowed: false, next: null });
  });
});
