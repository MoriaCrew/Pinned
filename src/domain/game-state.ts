/**
 * Game lifecycle skeleton (PIN-2 scaffold). PIN-5 owns the full domain
 * core: rubric math, winner rules, 0/1-entry close, token helpers.
 * Keep this file dependency-free so every layer can import it.
 */

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

/** Guessing only makes sense with enough entries to hide among (docs/01 G7). */
export function guessingApplies(entryCount: number): boolean {
  return entryCount >= 4;
}
