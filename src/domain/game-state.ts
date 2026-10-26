/**
 * Game lifecycle (PIN-5 domain core). Pure and dependency-free.
 * Semantics locked here so UI/AI issues never re-litigate them:
 * - forward-only DRAFT→OPEN→REVEAL→CLOSED
 * - repeating the current state is an idempotent no-op (deadline job
 *   vs admin force-close race: first writer wins, second is a no-op)
 * - 0 entries close with no winner; 1 entry wins by default;
 *   guessing only at >=4 entries (docs/01 G7, docs/05 §2.7)
 */
import type { Game } from "./types";

export type GameState = "DRAFT" | "OPEN" | "REVEAL" | "CLOSED";

const TRANSITIONS: Record<GameState, readonly GameState[]> = {
  DRAFT: ["OPEN"],
  OPEN: ["REVEAL"],
  REVEAL: ["CLOSED"],
  CLOSED: [],
};

export function canTransition(from: GameState, to: GameState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Guessing only makes sense with enough entries to hide among. */
export function guessingApplies(entryCount: number): boolean {
  return entryCount >= 4;
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: GameState,
    public readonly to: GameState,
  ) {
    super(`Invalid game transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export interface TransitionResult {
  game: Game;
  changed: boolean;
}

/**
 * Apply a transition immutably. Same-state requests return
 * { changed: false } — the deadline/force-close race loser must
 * never error. Anything else illegal throws InvalidTransitionError.
 */
export function transitionGame(game: Game, to: GameState, now: number): TransitionResult {
  if (game.state === to) return { game, changed: false };
  if (!canTransition(game.state, to)) throw new InvalidTransitionError(game.state, to);
  return {
    game: {
      ...game,
      state: to,
      version: game.version + 1,
      ...(to === "CLOSED" ? { closedAt: now } : {}),
    },
    changed: true,
  };
}

export type WinnerMode = "none" | "default" | "rubric";

/** What REVEAL looks like for a given entry count (docs/05 §2.7). */
export function planReveal(entryCount: number): { guessing: boolean; winnerMode: WinnerMode } {
  if (entryCount <= 0) return { guessing: false, winnerMode: "none" };
  if (entryCount === 1) return { guessing: false, winnerMode: "default" };
  return { guessing: guessingApplies(entryCount), winnerMode: "rubric" };
}
