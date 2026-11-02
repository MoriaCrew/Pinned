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
 *
 * PIN-137 (AiCallLog v2): full usage attribution. Every new field
 * is optional so pre-v2 records stay readable as-is; readers call
 * `normalizeAiCallLog` to fill the v2 view (boardId from the
 * legacy gameId, micro-USD from the float estimate). `boardId`
 * is the board slug — a capability secret: internal only, never
 * exported raw (usage:costs hashes it). `userIdAtCall` is a
 * snapshot resolved at call time and never backfilled. Costs are
 * ESTIMATES (list-price), labelled as such wherever surfaced.
 */

/** Typed denial outcomes (PIN-137): prefix + ReserveDenyReason. */
export type AiCallDenialOutcome =
  | "denied_off"
  | "denied_call_limit"
  | "denied_budget"
  | "denied_hourly_budget"
  | "denied_participant_cap"
  | "denied_board_cap"
  | "denied_photo_cap"
  | "denied_budget_unavailable";

export type AiCallOutcome =
  | "ok"
  | "error"
  | "refused"
  | AiCallDenialOutcome;

export interface AiCallLog {
  id: string;
  /** Legacy slug field (pre-PIN-137). New writers set boardId and
   *  mirror it here so old readers keep working. */
  gameId?: string;
  operation: string; // nameElements | segment | composeScene | ...
  model: string;
  promptVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  images?: number;
  latencyMs: number;
  /** Float USD estimate (v1). Kept for old readers; v2 prefers
   *  integer costMicroUsdEst. */
  costEstimateUsd?: number;
  /** "refused" added by PIN-61; denied_* by PIN-137. */
  outcome: AiCallOutcome;
  dayBucket: string; // YYYY-MM-DD, powers the daily kill-switch
  createdAt: number;
  // --- PIN-137 v2 attribution (all optional; absent on old rows) ---
  schemaVersion?: 2;
  /** Board slug. Internal only; never exported raw. */
  boardId?: string;
  participantId?: string;
  /** Signed-in user snapshot at call time; null when link-only /
   *  unclaimed. Never backfilled onto old rows. */
  userIdAtCall?: string | null;
  sceneId?: string;
  photoId?: string;
  jobId?: string;
  /** Integer micro-USD actually reserved (0 for denials). Estimate. */
  reservedMicroUsd?: number;
  /** Integer micro-USD estimated actual cost. Estimate only. */
  costMicroUsdEst?: number;
  /** Transcription unit: whole billed audio-seconds. */
  audioSeconds?: number;
  /** 0-based index of the final attempt (retry = 1). */
  attempt?: number;
  /** Provider attempts that actually ran (0 when denied upfront). */
  attempts?: number;
  /** Reserve deny reason on denied_* outcomes. */
  denialReason?: string;
  /** Epoch-ms expiry from Policy.aiCallLogRetentionDays. The
   *  Firestore TTL policy itself is console-side (see
   *  src/server/firestore-repository.ts expireAtTs note). */
  expireAt?: number;
}

/**
 * Migration-safe v2 view of any stored row (PIN-137): derives
 * boardId from legacy gameId and integer micro-USD from the float
 * estimate when the v2 fields are absent. Never invents a
 * userIdAtCall (null stays null/absent — no backfill).
 */
export function normalizeAiCallLog(log: AiCallLog): AiCallLog {
  const boardId = log.boardId ?? log.gameId;
  const costMicroUsdEst =
    log.costMicroUsdEst ??
    (log.costEstimateUsd !== undefined
      ? Math.max(0, Math.round(log.costEstimateUsd * 1_000_000))
      : undefined);
  return {
    ...log,
    ...(boardId ? { boardId } : {}),
    ...(costMicroUsdEst !== undefined ? { costMicroUsdEst } : {}),
  };
}

/** Estimated cost in USD from either shape (estimate only). */
export function aiCallCostUsdEst(log: AiCallLog): number {
  if (log.costMicroUsdEst !== undefined) return log.costMicroUsdEst / 1_000_000;
  return log.costEstimateUsd ?? 0;
}

export function isDeniedOutcome(outcome: string): boolean {
  return outcome.startsWith("denied_");
}
