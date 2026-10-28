import "server-only";
/**
 * Segmentation service (PIN-46 / PIN-8B).
 *
 * Turns a judged submission's objectLabel into a transparent
 * cut-out via SAM 3.1 (gateway), decoded and composited with the
 * PIN-36 lab utilities. Claim-before-call on segmentCount (cap 2:
 * initial + one tap-reselect) so duplicates never double-bill.
 * No usable mask is NOT an error: the outcome is "fallback" and
 * the whole-photo entry stands (PIN-47 offers the explicit
 * whole-photo choice on top of this).
 */
import { buildObjectPrompt } from "@meta-sam/parser";
import sharp from "sharp";
import type { GameRepository } from "../domain/repository";
import type { Submission } from "../domain/types";
import type { ModelGateway } from "../gateway/model-gateway";
import { assertDerivativeRef, type DerivativeStore } from "./derivative-store";
import { decodeSegment, renderCutout } from "./sam-mask";

export const MAX_SEGMENT_ATTEMPTS = 2;

export class SegmentSubmissionError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 409 | 429 | 502 = 502,
  ) {
    super(message);
    this.name = "SegmentSubmissionError";
  }
}

export function buildCutoutRef(gameId: string, playerId: string, submissionId: string): string {
  return assertDerivativeRef(
    `tmp/games/${gameId}/players/${playerId}/submissions/${submissionId}/cutout.png`,
  );
}

export interface SegmentDeps {
  repository: GameRepository;
  gateway: ModelGateway;
  store: DerivativeStore;
}

export interface SegmentOptions {
  /** Tap-reselect point as 0..1 fractions of the working image. */
  point?: { x: number; y: number };
}

export async function segmentSubmission(
  slug: string,
  submissionId: string,
  deps: SegmentDeps,
  options: SegmentOptions = {},
): Promise<{ submission: Submission; outcome: "cutout" | "fallback" | "already" }> {
  const all = await deps.repository.listSubmissions(slug);
  const submission = all.find((entry) => entry.id === submissionId);
  if (!submission) throw new SegmentSubmissionError("Submission not found.", 404);
  if (submission.status !== "active") {
    throw new SegmentSubmissionError("Only the current entry can be cut out.", 409);
  }
  if (submission.cutoutRef && !options.point) return { submission, outcome: "already" };
  if (!submission.objectLabel) {
    throw new SegmentSubmissionError("Judge this entry before cutting it out.", 409);
  }
  if (submission.segmentCount >= MAX_SEGMENT_ATTEMPTS) {
    throw new SegmentSubmissionError("No cut-out attempts left for this entry.", 429);
  }
  if (!submission.workingRef) {
    throw new SegmentSubmissionError("This entry has no photo to cut out.", 409);
  }

  const freshClaim = (await deps.repository.listSubmissions(slug)).find((e) => e.id === submissionId);
  if (!freshClaim || freshClaim.status !== "active" || freshClaim.segmentCount !== submission.segmentCount) {
    throw new SegmentSubmissionError("This entry changed while it was being cut out.", 409);
  }
  const claimed: Submission = { ...submission, segmentCount: submission.segmentCount + 1 };
  await deps.repository.putSubmission(claimed);

  const bytes = await deps.store.get(submission.workingRef);
  if (!bytes) throw new SegmentSubmissionError("The entry photo could not be loaded.", 502);
  const meta = await sharp(Buffer.from(bytes)).metadata();
  const frame = { width: meta.width ?? 0, height: meta.height ?? 0 };
  const imageRef = `data:image/webp;base64,${Buffer.from(bytes).toString("base64")}`;

  let promptText: string | undefined;
  if (options.point && frame.width > 0 && frame.height > 0) {
    promptText = buildObjectPrompt({
      size: { width: frame.width, height: frame.height },
      objects: [{ id: 1, prompts: [{ points: [{ x: Math.round(options.point.x * frame.width), y: Math.round(options.point.y * frame.height), label: "positive" }] }] }],
    });
  }

  const { segments } = await deps.gateway.segmentObject({
    imageRef,
    concept: submission.objectLabel,
    promptText,
  });

  const decoded = (segments ?? [])
    .map((segment) => {
      try {
        return decodeSegment(segment, frame);
      } catch {
        return null;
      }
    })
    .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment))
    .filter((segment) => segment.maskPixels > 0 && segment.coverageFrame > 0.001 && segment.coverageFrame < 0.98)
    .sort((a, b) => b.maskPixels - a.maskPixels)[0];

  if (!decoded) {
    console.warn("segmentation fallback (no usable mask)", { slug, submissionId });
    return { submission: claimed, outcome: "fallback" };
  }

  const cutout = await renderCutout(bytes, decoded);
  const cutoutRef = buildCutoutRef(slug, submission.playerId, submissionId);
  await deps.store.put(cutoutRef, cutout, "image/png");

  const fresh = (await deps.repository.listSubmissions(slug)).find((e) => e.id === submissionId);
  if (!fresh || fresh.status !== "active" || fresh.segmentCount !== claimed.segmentCount) {
    await deps.store.delete(cutoutRef).catch(() => undefined);
    throw new SegmentSubmissionError("This entry changed while it was being cut out.", 409);
  }
  const updated: Submission = { ...fresh, cutoutRef };
  await deps.repository.putSubmission(updated);
  return { submission: updated, outcome: "cutout" };
}
