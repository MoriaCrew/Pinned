"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyOptimisticConfirm,
  confirmPayload,
  downscaleTarget,
  isTerminalJob,
  newCandidatePins,
  selectionWithCandidates,
  shouldShowFaceNote,
  type JobStatusLike,
} from "../../../domain/add-sheet";
import type { BoardViewElement, BoardViewPin } from "../../../domain/board-view";
import { t } from "../../../i18n";
import type { BoardClientView } from "./BoardClient";

interface PublicJob {
  id: string;
  status: JobStatusLike;
  faceNote: boolean;
  pinIds: string[];
}

interface JobView {
  job: PublicJob;
  pins: (BoardViewPin & { boardId: string })[];
  elements: (BoardViewElement & { flattenedUrl: string; createdAt: number })[];
}

export const boardQueryKey = (slug: string) => ["board", slug] as const;

/**
 * Client downscale before upload (docs/11 section 5.8): decode,
 * cap the longest side at Policy.uploadMaxPx and re-encode JPEG.
 * Any decode failure uploads the original file — the server still
 * bounds, strips and re-encodes everything (photo-intake).
 */
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

/**
 * Add sheet (PIN-67, docs/11 section 6): photo -> "finding
 * things…" -> candidate pins pop in pre-selected (board poll while
 * the in-request job runs, then the job view) -> tap to drop ->
 * "Pin N ->" with optimistic pins. A face shows the one-line
 * consent note once per photo and never blocks pinning.
 */
export function AddSheet({
  slug,
  meId,
  boardView,
  uploadMaxPx,
  uploadJpegQuality,
  jobPollIntervalMs,
  onClose,
}: {
  slug: string;
  meId: string;
  boardView: BoardClientView;
  uploadMaxPx: number;
  uploadJpegQuality: number;
  jobPollIntervalMs: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [dismissedFaceJobId, setDismissedFaceJobId] = useState<string | null>(null);
  const knownPinIds = useRef<ReadonlySet<string>>(new Set(boardView.pins.map((p) => p.id)));

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const blob = await downscalePhoto(file, uploadMaxPx, uploadJpegQuality);
      const form = new FormData();
      form.set("photo", blob, "photo.jpg");
      const response = await fetch(`/api/boards/${encodeURIComponent(slug)}/photos`, {
        method: "POST",
        body: form,
      });
      const data = (await response.json()) as { job?: PublicJob; error?: string };
      if (!response.ok || !data.job) throw new Error(data.error || t("en", "add.failed"));
      return data.job;
    },
    onMutate: () => {
      const current = queryClient.getQueryData<BoardClientView>(boardQueryKey(slug));
      knownPinIds.current = new Set((current ?? boardView).pins.map((p) => p.id));
      setUploadError("");
      setSelected(new Set());
      setDropped(new Set());
    },
    onSuccess: (job) => setJobId(job.id),
    onError: (cause) =>
      setUploadError(cause instanceof Error ? cause.message : t("en", "add.failed")),
  });

  const jobQuery = useQuery({
    queryKey: ["board-job", slug, jobId],
    queryFn: async (): Promise<JobView> => {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(jobId ?? "")}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as JobView & { error?: string };
      if (!response.ok) throw new Error(data.error || t("en", "add.failed"));
      return data;
    },
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data && isTerminalJob(query.state.data.job.status) ? false : jobPollIntervalMs,
  });

  const job = jobQuery.data?.job ?? null;
  const jobPins = useMemo(() => jobQuery.data?.pins ?? [], [jobQuery.data]);
  const jobElements = useMemo(
    () => new Map((jobQuery.data?.elements ?? []).map((e) => [e.id, e])),
    [jobQuery.data],
  );
  // While the upload runs, candidates already persist server-side
  // per SAM call, so the board poll shows them pop in here too.
  const popInPins = useMemo(
    () => newCandidatePins(boardView, meId, knownPinIds.current),
    [boardView, meId],
  );
  const boardElements = useMemo(
    () => new Map(boardView.elements.map((e) => [e.id, e])),
    [boardView],
  );
  // Keep the board-poll pop-ins on screen until the job view
  // actually lands; switching on jobId alone would blank the
  // sheet (and the selection) for one fetch.
  const candidatePins: BoardViewPin[] = jobQuery.data ? jobPins : popInPins;
  const elementFor = (pin: BoardViewPin) =>
    jobElements.get(pin.elementId) ?? boardElements.get(pin.elementId);
  const candidateIds = candidatePins.map((p) => p.id);

  useEffect(() => {
    setSelected((current) => selectionWithCandidates(current, dropped, candidateIds));
    // candidateIds identity changes per render; key on its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateIds.join(","), dropped]);

  const confirm = useMutation({
    mutationFn: async (payload: { jobId: string; pinIds: string[] }) => {
      const response = await fetch(`/api/boards/${encodeURIComponent(slug)}/pins/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || t("en", "add.failed"));
      return data;
    },
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: boardQueryKey(slug) });
      const previous = queryClient.getQueryData<BoardClientView>(boardQueryKey(slug));
      if (previous) {
        queryClient.setQueryData(
          boardQueryKey(slug),
          applyOptimisticConfirm(previous, candidateIds, new Set(payload.pinIds)),
        );
      }
      return { previous };
    },
    onError: (_cause, _payload, context) => {
      if (context?.previous) queryClient.setQueryData(boardQueryKey(slug), context.previous);
      setUploadError(t("en", "add.failed"));
    },
    onSuccess: () => {
      setJobId(null);
      onClose();
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) }),
  });

  const finding =
    upload.isPending ||
    (jobId !== null && !jobQuery.data) ||
    (job !== null && !isTerminalJob(job.status));
  const payload = jobId ? confirmPayload(jobId, selected) : null;
  const canPin =
    payload !== null && job?.status === "ready" && !confirm.isPending;
  const showFaceNote = shouldShowFaceNote(job?.faceNote ?? false, jobId, dismissedFaceJobId);
  const terminalEmpty =
    job?.status === "ready" && candidatePins.length === 0;

  function toggle(pinId: string) {
    setDropped((current) => {
      const next = new Set(current);
      if (next.has(pinId)) next.delete(pinId);
      else next.add(pinId);
      return next;
    });
  }

  function resetForAnother() {
    setJobId(null);
    setSelected(new Set());
    setDropped(new Set());
    setUploadError("");
    upload.reset();
  }

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("en", "add.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{t("en", "add.title")}</h2>
          <button type="button" className="btn btn-small" onClick={onClose}>
            {t("en", "add.close")}
          </button>
        </div>

        {jobId === null && !upload.isPending ? (
          <label className="btn btn-primary sheet-pick">
            {t("en", "add.pick")}
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) upload.mutate(file);
              }}
            />
          </label>
        ) : null}

        {finding ? (
          <p className="hint" role="status">
            {t("en", "add.finding")}
          </p>
        ) : null}

        {showFaceNote ? (
          <p className="card sheet-face" role="status">
            {t("en", "add.faceNote")}{" "}
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setDismissedFaceJobId(jobId)}
            >
              {t("en", "add.gotIt")}
            </button>
          </p>
        ) : null}

        {candidatePins.length > 0 ? (
          <>
            <p className="hint">{t("en", "add.tapDrop")}</p>
            <ul className="pins-grid">
              {candidatePins.map((pin) => {
                const element = elementFor(pin);
                if (!element) return null;
                const keeping = selected.has(pin.id);
                return (
                  <li key={pin.id}>
                    <button
                      type="button"
                      className={`pin-card pin-toggle${keeping ? "" : " pin-dropped"}`}
                      aria-pressed={keeping}
                      onClick={() => toggle(pin.id)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- board-link-checked API image */}
                      <img src={element.imageUrl} alt={element.label} loading="lazy" />
                      <span className="pin-label">{element.label}</span>
                      <span className="state-pill">
                        {keeping ? t("en", "add.selected") : t("en", "add.dropped")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}

        {terminalEmpty ? <p className="hint" role="status">{t("en", "add.noneFound")}</p> : null}
        {job?.status === "failed" ? (
          <p className="error" role="alert">{t("en", "add.failed")}</p>
        ) : null}
        {job?.status === "refused" ? (
          <p className="error" role="alert">{t("en", "add.refused")}</p>
        ) : null}
        {uploadError ? (
          <p className="error" role="alert">{uploadError}</p>
        ) : null}

        <div className="sheet-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canPin}
            onClick={() => payload && confirm.mutate(payload)}
          >
            {confirm.isPending
              ? t("en", "add.pinning")
              : `${t("en", "add.pin")} ${selected.size} →`}
          </button>
          {job && isTerminalJob(job.status) ? (
            <button type="button" className="btn" onClick={resetForAnother}>
              {t("en", "add.another")}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
