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

/**
 * Coerce raw model scores onto the rubric (live evidence: Spark
 * sometimes answers 0-1 decimals or /10 values despite the
 * prompt). All-three <= 1 means a 0-1 scale: multiply by 5.
 * Everything is rounded and clamped to integers 0-5, then
 * strictly validated. Domain code keeps using validateScores.
 */
export function normalizeScores(raw: RubricScores): RubricScores {
  const values = [raw.fit, raw.effort, raw.chaos];
  const scale = values.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ? 5 : 1;
  const fix = (v: number) => Math.min(5, Math.max(0, Math.round((Number.isFinite(v) ? v : 0) * scale)));
  return validateScores({ fit: fix(raw.fit), effort: fix(raw.effort), chaos: fix(raw.chaos) });
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
