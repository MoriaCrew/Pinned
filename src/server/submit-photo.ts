/**
 * Photo submission use case (PIN-35 / PIN-7C).
 *
 * One active entry per player while the game is open. A resubmit
 * stores the new derivative first, then supersedes every previous
 * active entry for that player and deletes their derivatives
 * (the bucket lifecycle on `tmp/` is the backstop). No judging or
 * segmentation happens here — PIN-8/PIN-9 pick up active entries.
 */
import { randomUUID } from "node:crypto";
import { SubmissionRejectedError, type GameRepository } from "../domain/repository";
import type { Player, Submission } from "../domain/types";
import {
  buildWorkingImageRef,
  type DerivativeStore,
} from "./derivative-store";
import { PhotoIntakeError, processPhoto } from "./photo-intake";
import { resolvePlayerSession } from "./player-session";

export const MAX_SUBMISSIONS_PER_PLAYER = 12;
export const MAX_SUBMISSIONS_PER_GAME = 300;
export const MIN_SUBMIT_INTERVAL_MS = 5_000;

export class SubmitPhotoError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 404 | 409 | 429,
  ) {
    super(message);
    this.name = "SubmitPhotoError";
  }
}

export interface SubmitLimits {
  maxSubmissionsPerPlayer: number;
  maxSubmissionsPerGame: number;
  minIntervalMs: number;
}

export interface SubmitPhotoDependencies {
  repository: GameRepository;
  store: DerivativeStore;
  sessionSecret: string | null;
  now?: () => number;
  createSubmissionId?: () => string;
  limits?: Partial<SubmitLimits>;
}

export interface SubmitPhotoResult {
  submission: Submission;
  outcome: "created" | "replaced";
  width: number;
  height: number;
}

const DEFAULT_LIMITS: SubmitLimits = {
  maxSubmissionsPerPlayer: MAX_SUBMISSIONS_PER_PLAYER,
  maxSubmissionsPerGame: MAX_SUBMISSIONS_PER_GAME,
  minIntervalMs: MIN_SUBMIT_INTERVAL_MS,
};

export function findActiveSubmission(
  submissions: readonly Submission[],
  playerId: string,
): Submission | null {
  const actives = submissions
    .filter((s) => s.playerId === playerId && s.status === "active")
    .sort((a, b) => b.submittedAt - a.submittedAt);
  return actives[0] ?? null;
}

export async function getOwnSubmission(
  slug: string,
  cookieValue: string | null,
  deps: Pick<SubmitPhotoDependencies, "repository" | "sessionSecret" | "now">,
): Promise<{ player: Player; submission: Submission | null } | null> {
  const player = await resolvePlayerSession(slug, cookieValue, deps);
  if (!player) return null;
  const submissions = await deps.repository.listSubmissions(slug);
  return { player, submission: findActiveSubmission(submissions, player.id) };
}

export async function submitPhoto(
  slug: string,
  cookieValue: string | null,
  bytes: Uint8Array,
  deps: SubmitPhotoDependencies,
): Promise<SubmitPhotoResult> {
  const limits: SubmitLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now?.() ?? Date.now();

  const player = await resolvePlayerSession(slug, cookieValue, deps);
  if (!player) {
    throw new SubmitPhotoError("Join this game before submitting a photo.", 401);
  }
  const game = await deps.repository.getGame(slug);
  if (!game) throw new SubmitPhotoError("Game not found.", 404);
  if (game.state !== "OPEN" || now >= game.deadlineAt) {
    throw new SubmitPhotoError("Submissions are closed for this game.", 409);
  }

  const prior = await deps.repository.listSubmissions(slug);
  const mine = prior.filter((s) => s.playerId === player.id);
  if (mine.length >= limits.maxSubmissionsPerPlayer) {
    throw new SubmitPhotoError(
      "You have replaced your entry too many times. Your current entry stands.",
      429,
    );
  }
  if (prior.length >= limits.maxSubmissionsPerGame) {
    throw new SubmitPhotoError("This game has reached its entry limit.", 429);
  }
  const lastAt = mine.reduce((max, s) => Math.max(max, s.submittedAt), 0);
  if (lastAt && now - lastAt < limits.minIntervalMs) {
    throw new SubmitPhotoError("Give it a few seconds before submitting again.", 429);
  }

  const processed = await processPhoto(bytes);
  const submissionId = deps.createSubmissionId?.() ?? randomUUID();
  const workingRef = buildWorkingImageRef(slug, player.id, submissionId);
  await deps.store.put(workingRef, processed.derivative, processed.contentType);

  const submission: Submission = {
    id: submissionId,
    gameId: slug,
    playerId: player.id,
    workingRef,
    objectLabel: "",
    altLabel: "",
    scores: null,
    reason: "",
    privateJudgement: "",
    teaser: "",
    safetyFlags: {},
    status: "active",
    judgeCount: 0,
    segmentCount: 0,
    submittedAt: now,
    version: 1,
  };

  // One atomic repository unit: new active + supersede previous
  // actives + exact entry count, safe under concurrent submits.
  let recorded;
  try {
    recorded = await deps.repository.recordSubmission(submission, now, {
      now,
      maxSubmissionsPerPlayer: limits.maxSubmissionsPerPlayer,
      maxSubmissionsPerGame: limits.maxSubmissionsPerGame,
      minIntervalMs: limits.minIntervalMs,
    });
  } catch (error) {
    if (error instanceof SubmissionRejectedError) {
      await deps.store.delete(workingRef).catch(() => undefined);
      if (error.code === "game_closed") throw new SubmitPhotoError("Submissions are closed for this game.", 409);
      if (error.code === "player_cap") throw new SubmitPhotoError("You have replaced your entry too many times. Your current entry stands.", 429);
      if (error.code === "game_cap") throw new SubmitPhotoError("This game has reached its entry limit.", 429);
      throw new SubmitPhotoError("Give it a few seconds before submitting again.", 429);
    }
    // Ambiguous commit: only clean up if the record truly is absent.
    const saved = await deps.repository.listSubmissions(slug).then((all) => all.some((s) => s.id === submissionId), () => false);
    if (!saved) await deps.store.delete(workingRef).catch(() => undefined);
    throw error;
  }

  const superseded = recorded.superseded;
  for (const old of superseded) {
    if (!old.workingRef) continue;
    try {
      await deps.store.delete(old.workingRef);
    } catch (error) {
      // Record is already superseded; the tmp/ lifecycle is the backstop.
      console.warn("superseded derivative delete failed", {
        gameId: slug,
        submissionId: old.id,
        error,
      });
    }
  }

  return {
    submission,
    outcome: superseded.length > 0 ? "replaced" : "created",
    width: processed.width,
    height: processed.height,
  };
}

export function publicOwnSubmission(submission: Submission) {
  return {
    id: submission.id,
    status: submission.status,
    submittedAt: submission.submittedAt,
    hasPhoto: Boolean(submission.workingRef),
  };
}

export { PhotoIntakeError };
