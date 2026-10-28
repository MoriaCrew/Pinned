/**
 * Judging service (PIN-44 / PIN-9A).
 *
 * One gateway call per submission version: judgeCount is claimed
 * (persisted) BEFORE the call so a crash or duplicate trigger can
 * never double-bill; the cap of 2 leaves room for exactly one
 * retry after a failure. A submission that already has scores is
 * returned as-is (idempotent).
 *
 * The teaser is the only judged text other players see before the
 * reveal, so it is leak-checked server-side: if it contains the
 * player's display name or the object label, it is replaced with
 * a generic line.
 */
import type { GameRepository } from "../domain/repository";
import { validateScores } from "../domain/rubric";
import type { Submission } from "../domain/types";
import type { ModelGateway } from "../gateway/model-gateway";
import type { DerivativeStore } from "./derivative-store";

export const MAX_JUDGE_ATTEMPTS = 2;
export const GENERIC_TEASER = "A new entry has landed. The host has opinions.";

export class JudgeSubmissionError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 409 | 429 | 502 = 502,
  ) {
    super(message);
    this.name = "JudgeSubmissionError";
  }
}

function fold(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function teaserLeaks(teaser: string, objectLabel: string, displayName: string): boolean {
  const haystack = fold(teaser);
  const phrases = [displayName, objectLabel].map(fold).filter((value) => value.length >= 3);
  if (phrases.some((phrase) => haystack.includes(phrase))) return true;
  const needles = phrases.join(" ").split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3);
  return needles.some((word) => haystack.includes(word));
}

export interface JudgeDeps {
  repository: GameRepository;
  gateway: ModelGateway;
  store: DerivativeStore;
}

export async function judgeSubmission(
  slug: string,
  submissionId: string,
  deps: JudgeDeps,
): Promise<{ submission: Submission; outcome: "judged" | "already" }> {
  const game = await deps.repository.getGame(slug);
  if (!game) throw new JudgeSubmissionError("Game not found.", 404);
  const all = await deps.repository.listSubmissions(slug);
  const submission = all.find((entry) => entry.id === submissionId);
  if (!submission) throw new JudgeSubmissionError("Submission not found.", 404);
  if (submission.scores) return { submission, outcome: "already" };
  if (submission.status !== "active") {
    throw new JudgeSubmissionError("Only the current entry can be judged.", 409);
  }
  if (submission.judgeCount >= MAX_JUDGE_ATTEMPTS) {
    throw new JudgeSubmissionError("The host has already tried to judge this entry twice.", 429);
  }
  if (!submission.workingRef) {
    throw new JudgeSubmissionError("This entry has no photo to judge.", 409);
  }

  // Claim the attempt first: a failed call still counts, so a
  // retry storm cannot bill repeatedly.
  const claimed: Submission = { ...submission, judgeCount: submission.judgeCount + 1 };
  const freshClaim = (await deps.repository.listSubmissions(slug)).find((entry) => entry.id === submissionId);
  if (!freshClaim || freshClaim.status !== "active" || freshClaim.judgeCount !== submission.judgeCount || freshClaim.scores) {
    throw new JudgeSubmissionError("This entry changed while it was being judged.", 409);
  }
  await deps.repository.putSubmission(claimed);

  const bytes = await deps.store.get(submission.workingRef);
  if (!bytes) throw new JudgeSubmissionError("The entry photo could not be loaded.", 502);
  const imageRef = `data:image/webp;base64,${Buffer.from(bytes).toString("base64")}`;

  const player = await deps.repository.getPlayer(slug, submission.playerId);
  const judged = await deps.gateway.judgePhoto({
    imageRef,
    challenge: game.challenge,
    persona: game.persona,
  });

  const scores = validateScores(judged.scores);
  const objectLabel = judged.objectLabel.trim().slice(0, 80);
  const teaser = teaserLeaks(judged.teaser, objectLabel, player?.displayName ?? "")
    ? GENERIC_TEASER
    : judged.teaser.trim().slice(0, 140) || GENERIC_TEASER;

  const updated: Submission = {
    ...claimed,
    objectLabel,
    altLabel: judged.altLabel.trim().slice(0, 140),
    scores,
    reason: judged.reason.trim().slice(0, 240),
    privateJudgement: judged.privateJudgement.trim().slice(0, 600),
    teaser,
    safetyFlags: judged.safetyFlags ?? {},
  };
  // Re-read before the final write: a replace during the gateway
  // call supersedes this entry, and a stale full-document write
  // must never revive it (or overwrite a newer judgement).
  const fresh = (await deps.repository.listSubmissions(slug)).find((entry) => entry.id === submissionId);
  if (!fresh || fresh.status !== "active" || fresh.judgeCount !== claimed.judgeCount) {
    throw new JudgeSubmissionError("This entry changed while it was being judged.", 409);
  }
  const finalSubmission: Submission = { ...updated, status: fresh.status, supersededAt: fresh.supersededAt };
  await deps.repository.putSubmission(finalSubmission);
  return { submission: finalSubmission, outcome: "judged" };
}
