import "server-only";
/**
 * Object-labelling service (PIN-52, ex PIN-44 shell).
 *
 * One gateway call per submission version names the main object
 * (prompts/label.v1.md) so SAM can cut it out. labelCount is
 * claimed (persisted) BEFORE the call so a crash or duplicate
 * trigger can never double-bill; the cap of 2 leaves room for
 * exactly one retry after a failure. A submission that already
 * has a label is returned as-is (idempotent). No scores, no
 * verdict prose — the Studio pipeline replaces this with the
 * multi-element namer (PIN-53/60).
 */
import type { GameRepository } from "../domain/repository";
import type { Submission } from "../domain/types";
import type { ModelGateway } from "../gateway/model-gateway";
import { getPolicy } from "../policy/server";
import type { DerivativeStore } from "./derivative-store";

export const MAX_LABEL_ATTEMPTS = 2;

export class LabelSubmissionError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 409 | 429 | 502 = 502,
  ) {
    super(message);
    this.name = "LabelSubmissionError";
  }
}

export interface LabelDeps {
  repository: GameRepository;
  gateway: ModelGateway;
  store: DerivativeStore;
  /** Policy word cap for the concept phrase; defaults to getPolicy(). */
  maxConceptWords?: number;
}

export async function labelSubmission(
  slug: string,
  submissionId: string,
  deps: LabelDeps,
): Promise<{ submission: Submission; outcome: "labelled" | "already" }> {
  const game = await deps.repository.getGame(slug);
  if (!game) throw new LabelSubmissionError("Game not found.", 404);
  const all = await deps.repository.listSubmissions(slug);
  const submission = all.find((entry) => entry.id === submissionId);
  if (!submission) throw new LabelSubmissionError("Submission not found.", 404);
  if (submission.objectLabel) return { submission, outcome: "already" };
  if (submission.status !== "active") {
    throw new LabelSubmissionError("Only the current entry can be labelled.", 409);
  }
  // Stored pre-pivot submissions may lack labelCount; treat as 0.
  const labelCount = submission.labelCount ?? 0;
  if (labelCount >= MAX_LABEL_ATTEMPTS) {
    throw new LabelSubmissionError("This entry has already been labelled twice.", 429);
  }
  if (!submission.workingRef) {
    throw new LabelSubmissionError("This entry has no photo to label.", 409);
  }

  // Claim the attempt first: a failed call still counts, so a
  // retry storm cannot bill repeatedly.
  const claimed: Submission = { ...submission, labelCount: labelCount + 1 };
  const freshClaim = (await deps.repository.listSubmissions(slug)).find((entry) => entry.id === submissionId);
  if (!freshClaim || freshClaim.status !== "active" || (freshClaim.labelCount ?? 0) !== labelCount || freshClaim.objectLabel) {
    throw new LabelSubmissionError("This entry changed while it was being labelled.", 409);
  }
  await deps.repository.putSubmission(claimed);

  const bytes = await deps.store.get(submission.workingRef);
  if (!bytes) throw new LabelSubmissionError("The entry photo could not be loaded.", 502);
  const imageRef = `data:image/webp;base64,${Buffer.from(bytes).toString("base64")}`;

  const named = await deps.gateway.nameObject({
    imageRef,
    maxConceptWords: deps.maxConceptWords ?? getPolicy().conceptMaxWords,
  });

  const updated: Submission = {
    ...claimed,
    objectLabel: named.objectLabel.trim().slice(0, 80),
    altLabel: named.altLabel.trim().slice(0, 140),
    safetyFlags: named.safetyFlags ?? {},
  };
  // Re-read before the final write: a replace during the gateway
  // call supersedes this entry, and a stale full-document write
  // must never revive it.
  const fresh = (await deps.repository.listSubmissions(slug)).find((entry) => entry.id === submissionId);
  if (!fresh || fresh.status !== "active" || (fresh.labelCount ?? 0) !== claimed.labelCount) {
    throw new LabelSubmissionError("This entry changed while it was being labelled.", 409);
  }
  const finalSubmission: Submission = { ...updated, status: fresh.status, supersededAt: fresh.supersededAt };
  await deps.repository.putSubmission(finalSubmission);
  return { submission: finalSubmission, outcome: "labelled" };
}
