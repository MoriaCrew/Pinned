import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  canTransition,
  guessingApplies,
  planReveal,
  transitionGame,
} from "./game-state";
import type { Game } from "./types";

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: "slug-1",
    chainId: "chain-1",
    state: "DRAFT",
    brief: "brief",
    challenge: "challenge",
    persona: { name: "H", language: "en", voiceRules: [], catchphrases: [], judgingStyle: "dry" },
    adminTokenHash: "hash",
    deadlineAt: 1_000,
    entryCount: 0,
    createdAt: 0,
    version: 0,
    ...overrides,
  };
}

describe("game-state", () => {
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

  it("transitions immutably and bumps version", () => {
    const game = makeGame();
    const { game: next, changed } = transitionGame(game, "OPEN", 10);
    expect(changed).toBe(true);
    expect(next.state).toBe("OPEN");
    expect(next.version).toBe(1);
    expect(game.state).toBe("DRAFT");
  });

  it("same-state transition is an idempotent no-op (race loser)", () => {
    const game = makeGame({ state: "REVEAL", version: 3 });
    const result = transitionGame(game, "REVEAL", 10);
    expect(result.changed).toBe(false);
    expect(result.game.version).toBe(3);
  });

  it("illegal transitions throw InvalidTransitionError", () => {
    expect(() => transitionGame(makeGame(), "CLOSED", 0)).toThrow(InvalidTransitionError);
    expect(() => transitionGame(makeGame({ state: "CLOSED" }), "OPEN", 0)).toThrow(
      InvalidTransitionError,
    );
  });

  it("stamps closedAt only on CLOSED", () => {
    const reveal = makeGame({ state: "REVEAL" });
    expect(transitionGame(reveal, "CLOSED", 42).game.closedAt).toBe(42);
  });

  it("plans reveal for 0, 1, few and many entries", () => {
    expect(planReveal(0)).toEqual({ guessing: false, winnerMode: "none" });
    expect(planReveal(1)).toEqual({ guessing: false, winnerMode: "default" });
    expect(planReveal(3)).toEqual({ guessing: false, winnerMode: "rubric" });
    expect(planReveal(4)).toEqual({ guessing: true, winnerMode: "rubric" });
  });
});
