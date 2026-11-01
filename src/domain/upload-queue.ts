/**
 * Pure batch-upload queue logic (multi-photo pick): item states,
 * the per-file retry classification and the stepper order. The
 * BoardClient hook (useUploadQueue) owns files/blobs/fetches and
 * drives this state; the Add sheet steps through items in pick
 * order reusing the single-photo review. All counts and retry
 * bounds arrive from Policy (photosPerBatch, batchUploadConcurrency,
 * uploadRetry*) — no literals here.
 */
import { FREE_PHOTOS_USED } from "./free-photos";

export type UploadItemStatus =
  | "queued"
  | "uploading"
  | "ready"
  | "failed"
  | "refused"
  | "stopped"
  | "done"
  | "skipped";

export interface UploadQueueItem {
  /** Stable client identity for the item (never changes across retries). */
  key: string;
  /** Deterministic server job id for the current attempt (a retry re-mints it). */
  uploadId: string;
  status: UploadItemStatus;
  /** POST attempts made for the current uploadId. */
  attempts: number;
  /** Typed server code (credits_pool_empty, photos_per_day, intake codes) when one came back. */
  errorCode?: string;
  /** Friendly server message for a terminal per-file failure. */
  error?: string;
}

/** Queue at most `cap` of the picked ids; the rest are reported as dropped. */
/**
 * How many more photos the current batch may take under
 * Policy.photosPerBatch: unfinished items (not done/skipped) of an
 * in-flight batch count against the cap, so topping up mid-batch
 * (e.g. "Add another" from a leftover resume while uploads run)
 * can never grow the batch past the Policy size (Bugbot #148).
 */
export function batchRoom(
  items: readonly UploadQueueItem[],
  photosPerBatch: number,
): number {
  const active = items.filter(
    (item) => item.status !== "done" && item.status !== "skipped",
  ).length;
  return Math.max(0, photosPerBatch - active);
}

export function createQueueItems(
  ids: readonly { key: string; uploadId: string }[],
  cap: number,
): { items: UploadQueueItem[]; dropped: number } {
  const taken = ids.slice(0, Math.max(0, cap));
  return {
    items: taken.map((id) => ({
      key: id.key,
      uploadId: id.uploadId,
      status: "queued" as const,
      attempts: 0,
    })),
    dropped: ids.length - taken.length,
  };
}

/**
 * What one failed upload attempt means for the queue:
 * - "stop": coded pool-empty / per-day / free photos used (PIN-230)
 *   (and not-joined) — the queue stops; queued items become
 *   `stopped`, never retried blindly.
 * - "backoff": code-less 429 (per-IP brakes, in-process busy) and
 *   503 — wait and retry the same file under the same upload id.
 * - "check-job": network loss or an uncoded 5xx — the POST may have
 *   landed; GET the job first and adopt it instead of re-sending.
 * - "terminal": this file will not work (intake 4xx, refusals are a
 *   job state, not an HTTP failure) — fail the item, move on.
 */
export type UploadFailureAction = "stop" | "backoff" | "check-job" | "terminal";

/** Coded 429s that no retry can fix (PIN-151 pool, daily cap, PIN-230 free photos). */
const STOP_CODES: ReadonlySet<string> = new Set(["credits_pool_empty", "photos_per_day", FREE_PHOTOS_USED]);

export function classifyUploadFailure(input: {
  httpStatus?: number;
  code?: string;
  network?: boolean;
}): UploadFailureAction {
  if (input.network) return "check-job";
  if (input.code && STOP_CODES.has(input.code)) return "stop";
  if (input.httpStatus === 401) return "stop";
  if (input.httpStatus === 429) return "backoff";
  if (input.httpStatus === 503) return "backoff";
  if (input.httpStatus !== undefined && input.httpStatus >= 500) return "check-job";
  return "terminal";
}

/**
 * How a user-tapped retry proceeds once the item's existing job
 * has been looked up (Bugbot #148): a live or ready job is ADOPTED
 * — minting a fresh upload id would create and debit a second job
 * for the same photo. Only no job, or a terminally failed/refused
 * one, starts over under a fresh id.
 */
export function uploadRetryMode(
  jobStatus: "pending" | "running" | "ready" | "failed" | "refused" | null,
): "adopt" | "fresh-job" {
  return jobStatus !== null && jobStatus !== "failed" && jobStatus !== "refused"
    ? "adopt"
    : "fresh-job";
}

/** Map a terminal server job status onto the item status (non-terminal stays uploading). */
export function itemStatusForJob(
  jobStatus: "pending" | "running" | "ready" | "failed" | "refused",
): UploadItemStatus {
  if (jobStatus === "ready") return "ready";
  if (jobStatus === "failed") return "failed";
  if (jobStatus === "refused") return "refused";
  return "uploading";
}

/**
 * The stepper's next item: the first in pick order that is neither
 * done nor skipped. It may still be queued/uploading (the sheet
 * shows its cutting state) or failed (retry/skip) — stepping never
 * reorders photos.
 */
export function nextStepItem(items: readonly UploadQueueItem[]): UploadQueueItem | null {
  return items.find((item) => item.status !== "done" && item.status !== "skipped") ?? null;
}

/** 1-based step position of an item among all queued items, for "Photo i of n". */
export function stepPosition(
  items: readonly UploadQueueItem[],
  key: string,
): { index: number; total: number } | null {
  const index = items.findIndex((item) => item.key === key);
  if (index < 0) return null;
  return { index: index + 1, total: items.length };
}

/**
 * Apply a driver patch without resurrecting a user-settled item:
 * once the user skipped a photo (or it was pinned = done), a late
 * in-flight upload resolution must not flip it back to uploading,
 * ready or failed — the stepper would return to a photo already
 * left. Non-status fields still land; explicit user actions
 * (skip / done / retry) write through a separate forced path.
 */
export function applyItemPatch<T extends UploadQueueItem>(item: T, change: Partial<T>): T {
  if (
    (item.status === "skipped" || item.status === "done") &&
    change.status !== undefined &&
    change.status !== item.status
  ) {
    const safe = { ...change };
    delete safe.status;
    return { ...item, ...safe };
  }
  return { ...item, ...change };
}

/** True when nothing is left to step to: a new pick starts a fresh queue. */
export function isQueueSettled(items: readonly UploadQueueItem[]): boolean {
  return nextStepItem(items) === null;
}

/** Items still waiting behind (or in) the driver: queued + uploading. */
export function pendingCount(items: readonly UploadQueueItem[]): number {
  return items.filter((item) => item.status === "queued" || item.status === "uploading").length;
}
