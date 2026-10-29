import { describe, expect, it } from "vitest";
import {
  freshReclaimState,
  isReclaimLocked,
  recordReclaimFailure,
  type ReclaimLockoutParams,
} from "./reclaim-lockout";

const PARAMS: ReclaimLockoutParams = {
  maxFailures: 3,
  failureWindowMs: 100_000,
  lockoutBaseMs: 1_000,
  lockoutMaxMs: 5_000,
};
const T0 = 1_000_000;

describe("reclaim lockout math (PIN-90)", () => {
  it("stays unlocked below the threshold, then locks for the base duration", () => {
    let state = recordReclaimFailure("b", "k", null, T0, PARAMS);
    expect(state).toMatchObject({ failures: 1, firstFailureAt: T0, lockedUntil: 0 });
    state = recordReclaimFailure("b", "k", state, T0 + 10, PARAMS);
    expect(state.failures).toBe(2);
    expect(state.lockedUntil).toBe(0);
    state = recordReclaimFailure("b", "k", state, T0 + 20, PARAMS);
    expect(state.failures).toBe(3);
    expect(state.lockedUntil).toBe(T0 + 20 + 1_000);
    expect(isReclaimLocked(state, T0 + 20)).toBe(true);
    expect(isReclaimLocked(state, state.lockedUntil)).toBe(false);
  });

  it("doubles the lock per further failure, capped at the Policy max", () => {
    let state = recordReclaimFailure("b", "k", null, T0, PARAMS);
    state = recordReclaimFailure("b", "k", state, T0, PARAMS);
    state = recordReclaimFailure("b", "k", state, T0, PARAMS); // lock 1000
    state = recordReclaimFailure("b", "k", state, T0 + 1_000, PARAMS); // lock 2000
    expect(state.lockedUntil).toBe(T0 + 1_000 + 2_000);
    state = recordReclaimFailure("b", "k", state, T0 + 3_000, PARAMS); // lock 4000
    expect(state.lockedUntil).toBe(T0 + 3_000 + 4_000);
    state = recordReclaimFailure("b", "k", state, T0 + 7_000, PARAMS); // capped 5000
    expect(state.lockedUntil).toBe(T0 + 7_000 + 5_000);
    expect(state.failures).toBe(6);
    expect(state.firstFailureAt).toBe(T0);
  });

  it("decays to fresh once unlocked and the failure window has passed", () => {
    let state = recordReclaimFailure("b", "k", null, T0, PARAMS);
    state = recordReclaimFailure("b", "k", state, T0 + 10, PARAMS);
    expect(freshReclaimState(state, T0 + 10 + 99_999, PARAMS)).not.toBeNull();
    expect(freshReclaimState(state, T0 + 10 + 100_000, PARAMS)).toBeNull();
    const restarted = recordReclaimFailure(
      "b",
      "k",
      state,
      T0 + 10 + 100_000,
      PARAMS,
    );
    expect(restarted.failures).toBe(1);
    expect(restarted.firstFailureAt).toBe(T0 + 10 + 100_000);
  });

  it("a running lock never decays early", () => {
    let state = recordReclaimFailure("b", "k", null, T0, PARAMS);
    state = recordReclaimFailure("b", "k", state, T0, PARAMS);
    state = recordReclaimFailure("b", "k", state, T0, PARAMS);
    expect(state.lockedUntil).toBe(T0 + 1_000);
    expect(freshReclaimState(state, T0 + 999, PARAMS)).not.toBeNull();
    expect(isReclaimLocked(null, T0)).toBe(false);
  });
});
