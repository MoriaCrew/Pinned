"use client";

/**
 * The BoardClient-owned batch upload queue: files picked in one
 * action become ordinary single-photo DecomposeJobs, uploaded
 * serially (Policy.batchUploadConcurrency) with per-item
 * progress/failure/retry. It lives above the Add sheet, so closing
 * the sheet never kills an upload; page navigation drops it and
 * the board's leftovers take over, exactly like one photo today.
 *
 * Each item keeps its DOWNSCALED blob: the preview is made from it
 * and every retry re-sends byte-identical content under the same
 * deterministic upload id (a fresh id only after a terminal job,
 * via retryItem) — combined with the server's idempotent POST, a
 * lost response can never double-debit.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { downscaleTarget } from "../../../domain/add-sheet";
import {
  classifyUploadFailure,
  createQueueItems,
  itemStatusForJob,
  type UploadItemStatus,
  type UploadQueueItem,
} from "../../../domain/upload-queue";
import { t } from "../../../i18n";
import { useLocale } from "../../../i18n/client";

export interface BatchItem extends UploadQueueItem {
  file: File;
  /** The downscaled upload blob: preview source and the exact retry bytes. */
  blob?: Blob;
  previewUrl?: string;
}

interface JobLite {
  id: string;
  status: "pending" | "running" | "ready" | "failed" | "refused";
  errorCode?: string;
}

export interface UploadQueueOptions {
  slug: string;
  uploadMaxPx: number;
  uploadJpegQuality: number;
  jobPollIntervalMs: number;
  photosPerBatch: number;
  batchUploadConcurrency: number;
  uploadRetryMaxAttempts: number;
  uploadRetryBackoffMs: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A UUID for the deterministic upload/job id, with a non-secure-context fallback. */
function mintUploadId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Same client downscale as the single-photo Add path (docs/11 5.8). */
async function downscalePhoto(file: File, maxPx: number, quality: number): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() =>
      createImageBitmap(file),
    );
    try {
      const target = downscaleTarget(bitmap.width, bitmap.height, maxPx);
      if (!target.scaled && file.type === "image/jpeg") return file;
      const canvas = document.createElement("canvas");
      canvas.width = target.width;
      canvas.height = target.height;
      const context = canvas.getContext("2d");
      if (!context) return file;
      context.drawImage(bitmap, 0, 0, target.width, target.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
      return blob ?? file;
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}

export function useUploadQueue(options: UploadQueueOptions) {
  const locale = useLocale();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const [items, setItems] = useState<BatchItem[]>([]);
  const [dropped, setDropped] = useState(0);
  const itemsRef = useRef<BatchItem[]>([]);
  itemsRef.current = items;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const activeRef = useRef<Set<string>>(new Set());

  const patch = useCallback((key: string, change: Partial<BatchItem>) => {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );
  }, []);

  const fetchJob = useCallback(async (uploadId: string): Promise<JobLite | null> => {
    try {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(optionsRef.current.slug)}/jobs/${encodeURIComponent(uploadId)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return null;
      const data = (await response.json()) as { job?: JobLite };
      return data.job ?? null;
    } catch {
      return null;
    }
  }, []);

  /** Follow a known job to its terminal state and land it on the item. */
  const adoptJob = useCallback(
    async (item: BatchItem, first: JobLite): Promise<void> => {
      let job: JobLite | null = first;
      while (job && (job.status === "pending" || job.status === "running")) {
        await sleep(optionsRef.current.jobPollIntervalMs);
        // Skipped by the user while cutting: stop following it here;
        // the board poll + leftovers own it from then on.
        const current = itemsRef.current.find((i) => i.key === item.key);
        if (!current || current.status !== "uploading" || current.uploadId !== item.uploadId) return;
        job = (await fetchJob(item.uploadId)) ?? job;
      }
      if (!job) return;
      patch(item.key, {
        status: itemStatusForJob(job.status),
        ...(job.errorCode ? { errorCode: job.errorCode } : {}),
      });
    },
    [fetchJob, patch],
  );

  const processItem = useCallback(
    async (item: BatchItem): Promise<void> => {
      const opts = optionsRef.current;
      let blob = item.blob;
      if (!blob) {
        blob = await downscalePhoto(item.file, opts.uploadMaxPx, opts.uploadJpegQuality);
        patch(item.key, { blob, previewUrl: item.previewUrl ?? URL.createObjectURL(blob) });
      }
      for (let attempt = 1; attempt <= opts.uploadRetryMaxAttempts; attempt += 1) {
        patch(item.key, { status: "uploading", attempts: attempt });
        // Before any re-send, adopt a job a lost response may have created.
        if (attempt > 1) {
          const existing = await fetchJob(item.uploadId);
          if (existing) {
            await adoptJob(item, existing);
            return;
          }
        }
        let response: Response;
        let data: { job?: JobLite; error?: string; code?: string } = {};
        try {
          const form = new FormData();
          form.set("photo", blob, "photo.jpg");
          form.set("uploadId", item.uploadId);
          response = await fetch(`/api/boards/${encodeURIComponent(opts.slug)}/photos`, {
            method: "POST",
            body: form,
          });
          data = (await response.json().catch(() => ({}))) as typeof data;
        } catch {
          const existing = await fetchJob(item.uploadId);
          if (existing) {
            await adoptJob(item, existing);
            return;
          }
          if (attempt < opts.uploadRetryMaxAttempts) {
            await sleep(opts.uploadRetryBackoffMs * attempt);
            continue;
          }
          patch(item.key, { status: "failed", error: t(localeRef.current, "add.failed") });
          return;
        }
        if (response.ok && data.job) {
          await adoptJob(item, data.job);
          return;
        }
        const action = classifyUploadFailure({ httpStatus: response.status, code: data.code });
        if (action === "stop") {
          setItems((current) =>
            current.map((candidate) =>
              candidate.key === item.key || candidate.status === "queued"
                ? {
                    ...candidate,
                    status: "stopped" as UploadItemStatus,
                    ...(data.code ? { errorCode: data.code } : {}),
                    ...(data.error ? { error: data.error } : {}),
                  }
                : candidate,
            ),
          );
          return;
        }
        if (action === "check-job") {
          const existing = await fetchJob(item.uploadId);
          if (existing) {
            await adoptJob(item, existing);
            return;
          }
        }
        if (action === "backoff" || action === "check-job") {
          if (attempt < opts.uploadRetryMaxAttempts) {
            await sleep(opts.uploadRetryBackoffMs * attempt);
            continue;
          }
        }
        patch(item.key, {
          status: "failed",
          ...(data.code ? { errorCode: data.code } : {}),
          error: data.error || t(localeRef.current, "add.failed"),
        });
        return;
      }
    },
    [adoptJob, fetchJob, patch],
  );

  // Serial driver: run up to Policy.batchUploadConcurrency items at once.
  useEffect(() => {
    const capacity = optionsRef.current.batchUploadConcurrency - activeRef.current.size;
    if (capacity <= 0) return;
    const next = items.filter(
      (item) => item.status === "queued" && !activeRef.current.has(item.key),
    );
    for (const item of next.slice(0, capacity)) {
      activeRef.current.add(item.key);
      void processItem(item).finally(() => {
        activeRef.current.delete(item.key);
        // Re-trigger the driver for the next queued item.
        setItems((current) => [...current]);
      });
    }
  }, [items, processItem]);

  // Preview object URLs live and die with the queue on this page.
  useEffect(() => {
    const ref = itemsRef;
    return () => {
      for (const item of ref.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, []);

  const enqueue = useCallback((files: File[]): string | null => {
    if (files.length === 0) return null;
    const ids = files.map(() => {
      const id = mintUploadId();
      return { key: id, uploadId: id };
    });
    const { items: created, dropped: droppedCount } = createQueueItems(
      ids,
      optionsRef.current.photosPerBatch,
    );
    setDropped(droppedCount);
    const batch: BatchItem[] = created.map((item, index) => ({ ...item, file: files[index] }));
    setItems((current) => [...current, ...batch]);
    return batch[0]?.key ?? null;
  }, []);

  /** Retry a terminal/stopped item: fresh upload id (a new job), same blob bytes. */
  const retryItem = useCallback(
    (key: string) => {
      patch(key, {
        uploadId: mintUploadId(),
        status: "queued",
        attempts: 0,
        errorCode: undefined,
        error: undefined,
      });
    },
    [patch],
  );

  const skipItem = useCallback(
    (key: string) => patch(key, { status: "skipped" }),
    [patch],
  );
  const markDone = useCallback(
    (key: string) => patch(key, { status: "done" }),
    [patch],
  );

  return { items, dropped, enqueue, retryItem, skipItem, markDone };
}

export type UploadQueue = ReturnType<typeof useUploadQueue>;
