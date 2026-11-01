import { describe, expect, it } from "vitest";
import { clampStep, stepAfter } from "./walkthrough";

describe("models walk-through stepper (PIN-237)", () => {
  it("moves one step at a time and stops Back at the first step", () => {
    expect(stepAfter(0, "next", 4)).toBe(1);
    expect(stepAfter(2, "next", 4)).toBe(3);
    expect(stepAfter(2, "back", 4)).toBe(1);
    expect(stepAfter(0, "back", 4)).toBe(0);
  });

  it("starts over when Next is pressed on the last step", () => {
    expect(stepAfter(3, "next", 4)).toBe(0);
    expect(stepAfter(0, "next", 1)).toBe(0);
  });

  it("clamps any index from outside into range", () => {
    expect(clampStep(-2, 4)).toBe(0);
    expect(clampStep(9, 4)).toBe(3);
    expect(clampStep(1.7, 4)).toBe(1);
    expect(clampStep(Number.NaN, 4)).toBe(0);
    expect(clampStep(2, 0)).toBe(0);
    expect(stepAfter(9, "back", 4)).toBe(2);
  });
});
