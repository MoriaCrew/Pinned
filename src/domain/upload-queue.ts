/**
 * Pure batch-upload queue logic (multi-photo pick): item states,
 * the per-file retry classification and the stepper order. The
 * BoardClient hook (useUploadQueue) owns files/blobs/fetches and
 * drives this state; the Add sheet steps through items in pick
 * order reusing the single-photo review. All counts and retry
 * bounds arrive from Policy (photosPerBatch, batchUploadConcurrency,
 * uploadRetry*) — no literals here.
 */

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
 * - "stop": coded pool-empty / per-day (and not-joined) — the queue
 *   stops; queued items become `stopped`, never retried blindly.
 * - "backoff": code-less 429 (per-IP brakes, in-process busy) and
 *   503 — wait and retry the same file under the same upload id.
 * - "check-job": network loss or an uncoded 5xx — the POST may have
 *   landed; GET the job first and adopt it instead of re-sending.
 * - "terminal": this file will not work (intake 4xx, refusals are a
 *   job state, not an HTTP failure) — fail the item, move on.
 */
export type UploadFailureAction = "stop" | "backoff" | "check-job" | "terminal";

export function classifyUploadFailure(input: {
  httpStatus?: number;
  code?: string;
  network?: boolean;
}): UploadFailureAction {
  if (input.network) return "check-job";
  if (input.code === "credits_pool_empty" || input.code === "photos_per_day") return "stop";
  if (input.httpStatus === 401) return "stop";
  if (input.httpStatus === 429) return "backoff";
  if (input.httpStatus === 503) return "backoff";
  if (input.httpStatus !== undefined && input.httpStatus >= 500) return "check-job";
  return "terminal";
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

/** Items still waiting behind (or in) the driver: queued + uploading. */
export function pendingCount(items: readonly UploadQueueItem[]): number {
  return items.filter((item) => item.status === "queued" || item.status === "uploading").length;
}
