import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  parsePolicyOverridesJson,
  resolvePolicy,
} from "./policy";

describe("Policy (PIN-59, docs/11 §5.1)", () => {
  it("defaults carry the PIN-50 locks", () => {
    expect(DEFAULT_POLICY.sceneInputMode).toBe("flattened");
    expect(DEFAULT_POLICY.sceneSize).toBe("1024x1536");
    expect(DEFAULT_POLICY.sceneStore).toBe(false);
    expect(DEFAULT_POLICY.timeoutsMs).toEqual({
      spark: 30_000,
      sam: 20_000,
      scene: 120_000,
    });
    expect(DEFAULT_POLICY.maxTokens.sparkElements).toBe(4000);
    expect(DEFAULT_POLICY.faces).toBe("note");
    expect(DEFAULT_POLICY.retries).toBe(1);
    expect(DEFAULT_POLICY.retryBackoffMs).toBe(500);
    expect(resolvePolicy({ retryBackoffMs: 0 }).retryBackoffMs).toBe(0);
    expect(DEFAULT_POLICY.elementsPerPhoto).toEqual({ min: 1, max: 6 });
    expect(DEFAULT_POLICY.pinsPerScene).toEqual({ min: 1, max: 4 });
    expect(DEFAULT_POLICY.boardPollIntervalMs).toBe(5_000);
    expect(DEFAULT_POLICY.activityStripMax).toBe(5);
    // PIN-75 generated chips: TTL/cap/token budget/prompt version.
    expect(DEFAULT_POLICY.chipsCacheTtlHours).toBe(24);
    expect(DEFAULT_POLICY.chipsMax).toBe(4);
    expect(DEFAULT_POLICY.maxTokens.sparkChips).toBe(1200);
    expect(DEFAULT_POLICY.promptVersions.chips).toBe("chips.v1");
    expect(resolvePolicy({ chipsMax: 2, chipsCacheTtlHours: 1 }).chipsMax).toBe(2);
    expect(resolvePolicy({ maxTokens: { sparkChips: 800 } }).maxTokens).toEqual({
      sparkElements: 4000,
      sparkChips: 800,
    });
    expect(resolvePolicy({ boardPollIntervalMs: 1_000 }).boardPollIntervalMs).toBe(1_000);
    expect(() => resolvePolicy({ boardPollIntervalMs: 10 })).toThrow();
    // PIN-50 usable-mask window + flattened bounds (PIN-64).
    expect(DEFAULT_POLICY.usableMaskFrameFraction).toEqual({ min: 0.005, max: 0.6 });
    expect(DEFAULT_POLICY.flattenedMaxPx).toBe(1024);
    expect(DEFAULT_POLICY.flattenedPaddingFraction).toBe(0.08);
    expect(
      resolvePolicy({ usableMaskFrameFraction: { max: 0.5 } }).usableMaskFrameFraction,
    ).toEqual({ min: 0.005, max: 0.5 });
    expect(() =>
      resolvePolicy({ usableMaskFrameFraction: { min: 0.7, max: 0.6 } }),
    ).toThrow();
  });

  it("merge order is defaults < env < board, deep for nested", () => {
    const p = resolvePolicy(
      { elementsPerPhoto: { max: 4 }, timeoutsMs: { sam: 9_000 } },
      { elementsPerPhoto: { max: 2 } },
    );
    expect(p.elementsPerPhoto).toEqual({ min: 1, max: 2 });
    expect(p.timeoutsMs.sam).toBe(9_000);
    expect(p.timeoutsMs.spark).toBe(30_000);
  });

  it("dailyBudgetUsd 0 means off and survives resolution", () => {
    expect(resolvePolicy({ dailyBudgetUsd: 0 }).dailyBudgetUsd).toBe(0);
  });

  it("rejects inverted ranges and unknown faces mode", () => {
    expect(() =>
      resolvePolicy({ elementsPerPhoto: { min: 5, max: 2 } }),
    ).toThrow();
    expect(() =>
      // @ts-expect-error invalid enum on purpose
      resolvePolicy({ faces: "sometimes" }),
    ).toThrow();
  });

  it("parses POLICY_OVERRIDES_JSON and fails closed on garbage", () => {
    expect(parsePolicyOverridesJson(null)).toBeNull();
    expect(parsePolicyOverridesJson(" ")).toBeNull();
    expect(
      parsePolicyOverridesJson('{"scenesPerBoardPerDay": 5}'),
    ).toEqual({ scenesPerBoardPerDay: 5 });
    expect(() => parsePolicyOverridesJson("{nope")).toThrow(/not valid JSON/);
    expect(() => parsePolicyOverridesJson('{"faces": "x"}')).toThrow();
  });
});
