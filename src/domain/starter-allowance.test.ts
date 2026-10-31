import { describe, expect, it } from "vitest";
import { describeStarterAllowanceStoreContract } from "./starter-allowance.contract";
import {
  InMemoryStarterAllowanceStore,
  decideStarterSlot,
  type StarterAllowanceParams,
} from "./starter-allowance";

const PARAMS: StarterAllowanceParams = { maxBoards: 3, windowMs: 604_800_000 };

describe("decideStarterSlot (PIN-204)", () => {
  it("opens a window on the first board, with expireAt at its end", () => {
    expect(decideStarterSlot("k", null, 1_000, PARAMS)).toEqual({
      allowed: true,
      next: { key: "k", boards: 1, windowStartedAt: 1_000, lastBoardAt: 1_000, expireAt: 1_000 + PARAMS.windowMs },
    });
  });

  it("counts up to maxBoards, then refuses and records nothing", () => {
    let state = decideStarterSlot("k", null, 1_000, PARAMS).next;
    state = decideStarterSlot("k", state, 2_000, PARAMS).next;
    state = decideStarterSlot("k", state, 3_000, PARAMS).next;
    expect(state).toMatchObject({ boards: 3, windowStartedAt: 1_000, lastBoardAt: 3_000 });
    expect(decideStarterSlot("k", state, 4_000, PARAMS)).toEqual({ allowed: false, next: null });
  });

  it("starts a fresh window once windowMs has passed since the first board", () => {
    const full = { key: "k", boards: 3, windowStartedAt: 1_000, lastBoardAt: 3_000, expireAt: 1_000 + PARAMS.windowMs };
    expect(decideStarterSlot("k", full, 1_000 + PARAMS.windowMs - 1, PARAMS).allowed).toBe(false);
    expect(decideStarterSlot("k", full, 1_000 + PARAMS.windowMs, PARAMS).next).toMatchObject({
      boards: 1,
      windowStartedAt: 1_000 + PARAMS.windowMs,
    });
  });

  it("a claim refreshes expireAt from the current windowMs (Policy raised mid-window)", () => {
    const opened = decideStarterSlot("k", null, 1_000, { maxBoards: 3, windowMs: 1_000 }).next;
    expect(decideStarterSlot("k", opened, 1_500, { maxBoards: 3, windowMs: 5_000 }).next).toMatchObject({
      boards: 2,
      windowStartedAt: 1_000,
      expireAt: 6_000,
    });
  });

  it("maxBoards 0 never allows, even on a fresh window", () => {
    const zero = { ...PARAMS, maxBoards: 0 };
    expect(decideStarterSlot("k", null, 1_000, zero)).toEqual({ allowed: false, next: null });
  });

  it("never mutates the state it is given", () => {
    const state = { key: "k", boards: 1, windowStartedAt: 1_000, lastBoardAt: 1_000, expireAt: 1_000 + PARAMS.windowMs };
    const copy = structuredClone(state);
    decideStarterSlot("k", state, 2_000, PARAMS);
    expect(state).toEqual(copy);
  });
});

describeStarterAllowanceStoreContract("in-memory", () => new InMemoryStarterAllowanceStore());
