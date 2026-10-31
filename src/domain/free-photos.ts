/**
 * Free photos per board (PIN-230, docs/15 "Free photos rule"). Pure.
 *
 * Since PIN-229 a creation is an AI scene and photos never use the
 * pool, so a free board's photo cost is bounded by a cap instead:
 * the board's free photos (Policy `credits.freePhotosPerBoard`, or
 * the amount board creation stored for it). A board with Plus has
 * no photo limit; with credits off there is none either. The Policy
 * daily caps keep applying in every case.
 */
import type { DecomposeJob } from "./board";

/** Typed 429 code: the board used its free photos (PIN-230). Mirrored client-side. */
export const FREE_PHOTOS_USED = "free_photos_used";

export interface FreePhotoAllowanceInput {
  creditsEnabled: boolean;
  /** The board holds Plus that counts under the running PLUS_MODE. */
  hasPlus: boolean;
  /** Board.freePhotos, decided at creation (PIN-230); absent on older boards. */
  stored: number | undefined;
  /** Policy `credits.freePhotosPerBoard`, used when nothing is stored. */
  policyDefault: number;
}

/** The board's free photos, or null when its photos are not limited (credits off, or Plus). */
export function freePhotoAllowance(input: FreePhotoAllowanceInput): number | null {
  if (!input.creditsEnabled || input.hasPlus) return null;
  return input.stored ?? input.policyDefault;
}

/**
 * Photos that count against the allowance: a job that finished
 * `ready` (it gave cut-outs), or one still pending/running and not
 * yet stale (`now - updatedAt <= staleBoundMs`, the stale sweep's
 * bound), so parallel uploads cannot slip past the limit while a
 * dead job cannot hold a slot forever. Failed and refused photos
 * never count. Discarding cut-outs does not give a photo back: the
 * limit bounds AI cost, which a ready photo has already spent.
 */
export function countedPhotos(
  jobs: readonly Pick<DecomposeJob, "status" | "updatedAt">[],
  now: number,
  staleBoundMs: number,
): number {
  let count = 0;
  for (const job of jobs) {
    if (job.status === "ready") count += 1;
    else if ((job.status === "pending" || job.status === "running") && now - job.updatedAt <= staleBoundMs) {
      count += 1;
    }
  }
  return count;
}

/** Free photos left, never below 0. */
export function freePhotosLeft(allowance: number, used: number): number {
  return Math.max(0, allowance - used);
}
