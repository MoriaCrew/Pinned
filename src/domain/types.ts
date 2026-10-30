/**
 * Domain types for the AI-call log store. Pure types only —
 * persistence lives behind GameRepository. Times are epoch-ms
 * numbers so comparisons stay trivial. Invariant: no field
 * anywhere stores an original photo.
 *
 * PIN-93: the pre-Studio stored shapes (`Game`/`Player`/
 * `Submission`) went with the legacy game routes that were their
 * only readers; Studio boards live in `src/domain/board.ts`.
 * `AiCallLog` stays: every decorated AI call appends one.
 */

export interface AiCallLog {
  id: string;
  gameId?: string;
  operation: string; // nameObject | segmentObject | ...
  model: string;
  promptVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  images?: number;
  latencyMs: number;
  costEstimateUsd?: number;
  /** "refused" added by PIN-61: a provider refusal is a normal outcome. */
  outcome: "ok" | "error" | "refused";
  dayBucket: string; // YYYY-MM-DD, powers the daily kill-switch
  createdAt: number;
}
