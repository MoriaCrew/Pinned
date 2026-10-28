/**
 * Domain entities. Pure types only — persistence lives behind
 * GameRepository. Times are epoch-ms numbers so comparisons stay
 * trivial. Invariant: no field anywhere stores an original photo.
 *
 * PIN-52 seam: `Game`/`Submission` are the pre-Studio stored shapes.
 * They stay readable so existing boards keep serving on /g/{slug}
 * until the Studio data model replaces them (PIN-62/66). Fields
 * that only existed for the dropped game (scores, host prose,
 * winners) are gone; stored documents may still carry them and
 * they are ignored on read.
 */
import type { BoardThemeTokens } from "./board-themes";

export type { BoardThemeTokens };

/** Stored lifecycle values on pre-Studio games; "OPEN" gates joins. */
export type GameState = "DRAFT" | "OPEN" | "REVEAL" | "CLOSED";

export interface GameChain {
  id: string;
  creatorUid?: string; // optional mode; null/absent in link-only
  gameCount: number;
  createdAt: number;
}

export interface Game {
  id: string; // = slug; Firestore doc id
  chainId: string;
  state: GameState;
  challenge: string;
  /** Board theme id (PIN-52); pre-pivot games stored it as presetId. */
  themeId?: string;
  /** @deprecated pre-pivot stored name for themeId; read-only. */
  presetId?: string;
  theme?: BoardThemeTokens; // per-board design tokens
  adminTokenHash: string; // sha256 hex, never the token itself
  creatorUid?: string;
  deadlineAt: number; // stored join/submit cutoff on existing games
  entryCount: number;
  createdAt: number;
  closedAt?: number;
  version: number; // optimistic-concurrency counter
}

export interface Player {
  id: string;
  gameId: string;
  displayName: string;
  cookieSecretHash: string;
  posterOptIn: boolean;
  reclaimPinHash?: string;
  createdAt: number;
}

export type SubmissionStatus = "active" | "hidden" | "superseded";

export interface Submission {
  id: string;
  gameId: string;
  playerId: string;
  workingRef?: string; // metadata-stripped working derivative, never original
  cutoutRef?: string; // SAM cut-out, never original
  objectLabel: string; // SAM concept phrase (label.v1)
  altLabel: string;
  safetyFlags: { screens?: boolean; documents?: boolean; faces?: boolean };
  status: SubmissionStatus;
  labelCount: number; // caps: max 2 (claim-before-call)
  segmentCount: number; // caps: max 2 (1 + 1 tap-reselect)
  submittedAt: number;
  supersededAt?: number; // set when the player replaces this entry
  version: number;
}

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
