/**
 * Rubric math (PIN-5, FR1.4). Scores decide; host prose only
 * explains. Winner = highest Fit+Effort+Chaos total, tie-break:
 * earlier submission, then id (deterministic for tests/replays).
 */
import type { RubricScores, Submission } from "./types";

function assertScore(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 5) {
    throw new RangeError(`Rubric score ${name} must be an integer 0-5, got ${value}`);
  }
}

export function validateScores(scores: RubricScores): RubricScores {
  assertScore("fit", scores.fit);
  assertScore("effort", scores.effort);
  assertScore("chaos", scores.chaos);
  return scores;
}

export function totalScore(scores: RubricScores): number {
  validateScores(scores);
  return scores.fit + scores.effort + scores.chaos;
}

type Scored = Pick<Submission, "id" | "scores" | "submittedAt" | "status">;

/** Active, judged submissions best-first. Input is not mutated. */
export function rankSubmissions<T extends Scored>(submissions: readonly T[]): T[] {
  return submissions
    .filter((s) => s.status === "active" && s.scores !== null)
    .sort((a, b) => {
      const byTotal = totalScore(b.scores as RubricScores) - totalScore(a.scores as RubricScores);
      if (byTotal !== 0) return byTotal;
      if (a.submittedAt !== b.submittedAt) return a.submittedAt - b.submittedAt;
      return a.id.localeCompare(b.id);
    });
}

export function pickWinner<T extends Scored>(submissions: readonly T[]): T | null {
  return rankSubmissions(submissions)[0] ?? null;
}
