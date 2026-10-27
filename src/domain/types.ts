/**
 * Domain entities (PIN-5). Pure types only — persistence arrives
 * behind GameRepository with Firestore later. Times are epoch-ms
 * numbers so deadline and tie-break comparisons stay trivial.
 * Invariant: no field anywhere stores an original photo (NFR2).
 */
import type { HostPersona, RubricScores } from "../gateway/model-gateway";
import type { GameState } from "./game-state";

export type { GameState, HostPersona, RubricScores };

export type RoastLevel = "gentle" | "spicy" | "feral";

export interface GameChain {
  id: string;
  creatorUid?: string; // FR8 optional mode; null/absent in link-only
  gameCount: number;
  createdAt: number;
}

export interface Game {
  id: string; // = slug; Firestore doc id (docs/05 §3)
  chainId: string;
  state: GameState;
  brief: string;
  challenge: string;
  persona: HostPersona; // embedded, immutable per game
  personaPromptVersion?: string; // prompts/persona.v*.md contract used
  adminTokenHash: string; // sha256 hex, never the token itself
  creatorUid?: string;
  deadlineAt: number;
  guessingClosesAt?: number;
  entryCount: number;
  winnerSubmissionId?: string;
  createdAt: number;
  closedAt?: number;
  version: number; // optimistic-concurrency counter for CAS
}

export interface Player {
  id: string;
  gameId: string;
  displayName: string;
  cookieSecretHash: string;
  roastLevel: RoastLevel;
  posterOptIn: boolean;
  reclaimPinHash?: string;
  createdAt: number;
}

export type SubmissionStatus = "active" | "hidden" | "superseded";

export interface Submission {
  id: string;
  gameId: string;
  playerId: string;
  workingRef?: string; // metadata-stripped working derivative (PIN-34), never original
  cutoutRef?: string; // SAM cut-out (PIN-8), never original
  objectLabel: string;
  altLabel: string;
  scores: RubricScores | null; // hidden from players until REVEAL
  reason: string;
  privateJudgement: string;
  teaser: string;
  safetyFlags: { screens?: boolean; documents?: boolean; faces?: boolean };
  status: SubmissionStatus;
  judgeCount: number; // caps: max 2 (docs/05 §2.3)
  segmentCount: number; // caps: max 2 (1 + 1 tap-reselect)
  submittedAt: number;
  supersededAt?: number; // set when the player replaces this entry (PIN-35)
  version: number;
}

export interface Guess {
  id: string;
  gameId: string;
  guesserPlayerId: string;
  submissionId: string;
  guessedOwnerPlayerId: string;
  createdAt: number;
}

export type PosterStatus = "pending" | "ready" | "failed";

export interface Poster {
  id: string;
  gameId: string;
  backgroundRef?: string;
  compositeRef?: string;
  cardRef?: string;
  status: PosterStatus;
  createdAt: number;
}

export interface DiaryEntry {
  id: string;
  chainId: string;
  gameId: string;
  winnerPlayerId: string | null;
  superlatives: string[];
  runningJokes: string[]; // game facts only (FR6.3)
  createdAt: number;
}

export interface AiCallLog {
  id: string;
  gameId?: string;
  operation: string; // generatePersona | judgePhoto | segmentObject | ...
  model: string;
  promptVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  images?: number;
  latencyMs: number;
  costEstimateUsd?: number;
  outcome: "ok" | "error";
  dayBucket: string; // YYYY-MM-DD, powers the daily kill-switch
  createdAt: number;
}
