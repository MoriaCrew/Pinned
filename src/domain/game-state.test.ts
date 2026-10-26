import { describe, expect, it } from "vitest";
import { canTransition, guessingApplies } from "./game-state";

describe("game-state skeleton", () => {
  it("allows only forward lifecycle steps", () => {
    expect(canTransition("DRAFT", "OPEN")).toBe(true);
    expect(canTransition("OPEN", "REVEAL")).toBe(true);
    expect(canTransition("REVEAL", "CLOSED")).toBe(true);
    expect(canTransition("OPEN", "CLOSED")).toBe(false);
    expect(canTransition("CLOSED", "OPEN")).toBe(false);
  });

  it("guessing starts at four entries", () => {
    expect(guessingApplies(3)).toBe(false);
    expect(guessingApplies(4)).toBe(true);
  });
});
