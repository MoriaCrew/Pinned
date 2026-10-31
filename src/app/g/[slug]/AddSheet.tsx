"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addSheetStage,
  applyOptimisticConfirm,
  canConfirmJob,
  canTapAdd,
  confirmPayload,
  cuttingProgress,
  downscaleTarget,
  isAwaitingTapPin,
  isTerminalJob,
  maskBoxOf,
  newCandidatePins,
  normalizedTapPoint,
  overlayRect,
  reviewHelp,
  selectionWithCandidates,
  shouldShowFaceNote,
  spreadLabels,
  type AddStage,
  type JobStatusLike,
  type MaskBoxLike,
  type OverlayRect,
  type PendingTapPin,
  type ReviewHelp,
} from "../../../domain/add-sheet";
import { aiBudgetDenial } from "../../../domain/ai-budget";
import type { BoardViewElement, BoardViewPin } from "../../../domain/board-view";
import { familiesOnBoard, libraryPinState, libraryStripView } from "../../../domain/library-strip";
import { isPoolEmptyCode } from "../../../domain/makes-ui";
import { formatList, t, tCount, tf, type Locale } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import type { UploadItemStatus } from "../../../domain/upload-queue";
import { Button, Hint, Icon, Pin, Sheet, Sticker, Tag, cx } from "../../../ui";
import type { BoardClientView } from "./BoardClient";
import { useAuth } from "../../auth/AuthProvider";
import { LibraryList, LibraryStrip, useLibraryPins } from "./LibraryPins";
import { PhotoPick } from "./PhotoPick";
import {
  claimStashedPhoto,
  dropStashedPhoto,
  photoForJob,
  rememberJobPhoto,
  stashUploadingPhoto,
  type PhotoMemoryStore,
} from "./photo-memory";

const revokeUrl = (url: string) => URL.revokeObjectURL(url);

interface PublicJob {
  id: string;
  status: JobStatusLike;
  faceNote: boolean;
  pinIds: string[];
  elementIds?: string[];
  workingCopyGone?: boolean;
  /** PIN-151: typed failure code, e.g. the empty makes pool. */
  errorCode?: string;
}

/** The public element payload carries its maskBox (PIN-99); library copies may not. */
type CandidateElement = BoardViewElement & { maskBox?: MaskBoxLike };

interface JobView {
  job: PublicJob;
  pins: (BoardViewPin & { boardId: string })[];
  elements: (CandidateElement & { flattenedUrl: string; createdAt: number })[];
}

export const boardQueryKey = (slug: string) => ["board", slug] as const;

/** The review's help line (PIN-126). */
export function reviewHelpLine(help: ReviewHelp, locale: Locale): string {
  if (help.kind === "noneKept") return t(locale, "add.noneKept");
  if (help.kind === "someLeftOut") return tCount(locale, "add.leftOut", help.n);
  return t(locale, "add.tapDrop");
}

/**
 * The last uploaded photo's LOCAL preview (an object URL of the
 * picked file, never uploaded as-is), kept by the board page across
 * sheet closes (PIN-122) so "Pin them" can show that photo again in
 * the same visit. A reload forgets it: the review then shows the
 * stickers only.
 */
/**
 * The board page's memory of the last photo's local preview
 * (`createPhotoMemory`). `jobId` is null while its upload is still in
 * flight after the sheet closed (PIN-126); the upload's success fills
 * it in, a failure releases the URL. Open sheets are told on change.
 */
export type PhotoMemory = PhotoMemoryStore;

/**
 * One step of a BoardClient batch (multi-photo pick): the sheet is
 * remounted per photo with `resumeJobId` set to the item's upload
 * id, so the whole single-photo review (pop-in, tap-to-add, face
 * note, Pin N) is reused unchanged. The queue owns the preview
 * URL; confirming, skipping and retrying are reported up and the
 * board page advances the step or closes the sheet.
 */
export interface AddBatchStep {
  itemStatus: UploadItemStatus;
  previewUrl: string | null;
  errorCode?: string;
  error?: string;
  /** 1-based position and queue size, for "Photo i of n". */
  index: number;
  total: number;
  /** Per-item statuses in pick order, for the one-line progress summary. */
  states: readonly UploadItemStatus[];
  /** Files the last pick dropped over Policy.photosPerBatch. */
  droppedCount: number;
  onConfirmed(jobId: string): void;
  onSkip(): void;
  onRetry(): void;
}

const noSubscribe = () => () => {};

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

/** One friendly line that names the fix; errors are alerts, the rest is status. */
function SheetLine({ tone = "info", children }: { tone?: "info" | "error"; children: ReactNode }) {
  return (
    <p className={cx("pn-add-line", tone === "error" && "pn-add-line-error")} role={tone === "error" ? "alert" : "status"}>
      <Icon name="info" size={18} />
      <span>{children}</span>
    </p>
  );
}

/** "Finding things" / "Cutting out" + one line of what is happening. */
function CutStatus({ tag, children }: { tag: string; children: ReactNode }) {
  return (
    <div className="pn-cut-status" role="status" aria-live="polite">
      <Tag tone="ink" icon="cut">
        {tag}
      </Tag>
      <p className="pn-cut-line">{children}</p>
    </div>
  );
}

interface LiftedSticker {
  id: string;
  label: string;
  src: string;
  seed: string;
  rect: OverlayRect;
  cutting: boolean;
}

const pct = (fraction: number) => `${fraction * 100}%`;

/**
 * The photo at the heart of the cut-out moment: a sweep while
 * finding, dimmed with each sticker lifted at its maskBox while
 * cutting, and the tap surface (PIN-78) while reviewing. The frame
 * takes the photo's own aspect ratio, so the tap box IS the image.
 */
function CutPhoto({
  src,
  stage,
  lifted,
  tap,
  lastTap,
}: {
  src: string;
  stage: AddStage;
  lifted: LiftedSticker[];
  tap: { working: boolean; disabled: boolean; onTap: (point: { x: number; y: number }) => void } | null;
  lastTap: { x: number; y: number } | null;
}) {
  const locale = useLocale();
  const [ratio, setRatio] = useState<number | null>(null);
  const style = ratio ? ({ "--ratio": ratio } as CSSProperties) : undefined;
  return (
    <div className="pn-cut-photo" data-stage={stage} data-working={tap?.working ? "" : undefined} style={style}>
      <div className="pn-cut-frame">
        {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview of the picked file */}
        <img
          src={src}
          alt={t(locale, "add.photoAlt")}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (naturalWidth > 0 && naturalHeight > 0) setRatio(naturalWidth / naturalHeight);
          }}
        />
        {stage === "finding" ? <span className="pn-cut-sweep" aria-hidden="true" /> : null}
        {tap ? (
          <button
            type="button"
            className="pn-cut-tap"
            aria-label={t(locale, "add.tapHint")}
            disabled={tap.disabled}
            onClick={(event) => {
              const point = normalizedTapPoint(
                event.clientX,
                event.clientY,
                event.currentTarget.getBoundingClientRect(),
              );
              if (point) tap.onTap(point);
            }}
          />
        ) : null}
        {tap && lastTap ? (
          <span
            className="pn-cut-dot"
            data-working={tap.working ? "" : undefined}
            aria-hidden="true"
            style={{ left: pct(lastTap.x), top: pct(lastTap.y) }}
          />
        ) : null}
      </div>
      {lifted.map((item) => (
        <span
          key={item.id}
          className="pn-cut-lift"
          data-cutting={item.cutting ? "" : undefined}
          aria-hidden="true"
          style={{ left: pct(item.rect.left), top: pct(item.rect.top), width: pct(item.rect.width), height: pct(item.rect.height) }}
        >
          <Sticker src={item.src} seed={item.seed} tilt={0} state={item.cutting ? "cutting" : "rest"} loading="eager" />
        </span>
      ))}
      {lifted.map((item) => (
        <span
          key={`${item.id}-label`}
          className="pn-cut-label"
          data-below={item.rect.label.below ? "" : undefined}
          style={{ left: pct(item.rect.label.x), top: pct(item.rect.label.y) }}
        >
          <span>{item.label}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Add sheet (PIN-67, docs/11 section 6), rebuilt as the design
 * system's cut-out moment (PIN-99, docs/14): pick a photo → the
 * photo with a sweep while Spark finds things → each candidate's
 * sticker lifts off the photo at its maskBox as it lands (board
 * poll while the in-request job runs, then the job view) → review:
 * every thing kept, tap one to drop it, tap the photo to add a
 * missed one (PIN-78) → "Pin N things" with optimistic pins. A
 * face shows the one-line consent note once per photo and never
 * blocks pinning. PIN-121: signed in, the pick step also offers
 * "From your other boards" under the photo target (one tap pins a
 * thing here) with "See all" for the full library list. PIN-122:
 * with `resumeJobId` the sheet opens straight at that photo's
 * review (leftovers): all its candidates kept, the photo shown when
 * this visit still has it, and a one-line note instead of the photo
 * once its working copy is gone; "Pin N things" is the same confirm.
 */
export function AddSheet({
  slug,
  meId,
  boardView,
  uploadMaxPx,
  uploadJpegQuality,
  jobPollIntervalMs,
  elementsPerPhotoMax,
  libraryStripMax,
  resumeJobId = null,
  photoMemory,
  onAddMakes,
  onPickFiles,
  batch = null,
  onClose,
}: {
  slug: string;
  meId: string;
  boardView: BoardClientView;
  uploadMaxPx: number;
  uploadJpegQuality: number;
  jobPollIntervalMs: number;
  elementsPerPhotoMax: number;
  /** Policy.libraryStripMax (PIN-121). */
  libraryStripMax: number;
  /** Open at this photo job's review (PIN-122 leftovers). */
  resumeJobId?: string | null;
  photoMemory?: PhotoMemory;
  /** PIN-152: out of makes — open the buy sheet (only passed while buying can work). */
  onAddMakes?: () => void;
  /** Batch pick: several files go to the BoardClient queue instead of the legacy single upload. */
  onPickFiles?: (files: File[]) => void;
  /** The current batch step, when this sheet is stepping through a multi-photo pick. */
  batch?: AddBatchStep | null;
  onClose: () => void;
}) {
  const locale = useLocale();
  const queryClient = useQueryClient();
  // PIN-121: the library strip and its "See all" list. Disabled auth
  // (link-only or signed out) keeps the photo-only sheet.
  const auth = useAuth();
  const signedIn = auth.enabled && auth.status === "signedIn";
  const library = useLibraryPins(slug, signedIn, boardView.board.title);
  const [seeAll, setSeeAll] = useState(false);
  const stripHeadingId = useId();
  const seeAllId = `${stripHeadingId}-all`;
  // Set by the list's Back only: focus returns to "See all" once,
  // never when the strip remounts later (e.g. after "Add another").
  const focusSeeAll = useRef(false);
  useEffect(() => {
    if (seeAll || !focusSeeAll.current) return;
    focusSeeAll.current = false;
    document.getElementById(seeAllId)?.focus();
  }, [seeAll, seeAllId]);
  const [jobId, setJobId] = useState<string | null>(resumeJobId);
  const [uploadError, setUploadError] = useState("");
  // PIN-152: the upload stopped at the empty makes pool (429).
  const [uploadPoolEmpty, setUploadPoolEmpty] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [dismissedFaceJobId, setDismissedFaceJobId] = useState<string | null>(null);
  const knownPinIds = useRef<ReadonlySet<string>>(new Set(boardView.pins.map((p) => p.id)));
  // Tap-to-add (PIN-78): the preview is a LOCAL object URL of the
  // picked file (never uploaded/stored as-is; the server segments
  // its own stripped working copy). Photo intake auto-rotates and
  // browsers apply EXIF orientation to <img>, so normalized tap
  // points line up with the working copy's frame.
  const remembered = photoForJob(photoMemory?.current ?? null, resumeJobId);
  // Read live too: a photo stashed mid-upload gets its job only when
  // that upload returns, possibly after this sheet opened (PIN-126).
  const memorySlot = useSyncExternalStore(
    photoMemory?.subscribe ?? noSubscribe,
    () => photoMemory?.current ?? null,
    () => null,
  );
  const rememberedLive = photoForJob(memorySlot, resumeJobId);
  // In a batch step the queue owns the preview (made from the
  // downscaled blob); the sheet shows it but must never revoke it.
  const batchPreviewUrl = batch?.previewUrl ?? null;
  // Ref mirror: the unmount cleanup is an empty-deps effect, so a
  // first-render closure must read the LATEST batch preview here or
  // it would revoke a queue-owned URL that arrived after mount.
  const batchPreviewRef = useRef<string | null>(batchPreviewUrl);
  batchPreviewRef.current = batchPreviewUrl;
  const [previewUrl, setPreviewUrl] = useState<string | null>(batchPreviewUrl ?? remembered);
  const previewRef = useRef<string | null>(batchPreviewUrl ?? remembered);
  const [tapError, setTapError] = useState("");
  const [lastTap, setLastTap] = useState<{ x: number; y: number } | null>(null);
  const [pendingTapPin, setPendingTapPin] = useState<PendingTapPin | null>(null);

  // The board page's photo memory owns its URL; everything else
  // this sheet made, it revokes.
  function releasePreview() {
    const url = previewRef.current;
    if (url && url === batchPreviewRef.current) return; // the queue owns it
    if (url && photoMemory?.current?.url !== url) URL.revokeObjectURL(url);
  }

  // False once the sheet is gone: an upload that lands after a close
  // must not remember a preview the unmount already revoked.
  const mounted = useRef(true);

  function rememberPhoto(forJobId: string) {
    const url = previewRef.current;
    if (!photoMemory || !url) return;
    if (!mounted.current) {
      // Closed mid-upload (PIN-126): the board page took the preview
      // at unmount; give it its job now (unless a newer photo won).
      photoMemory.current = claimStashedPhoto(photoMemory.current, url, forJobId);
      return;
    }
    photoMemory.current = rememberJobPhoto(photoMemory.current, forJobId, url, revokeUrl);
  }

  function showPreview(file: File) {
    releasePreview();
    const url = URL.createObjectURL(file);
    previewRef.current = url;
    setPreviewUrl(url);
  }

  function clearPreview() {
    releasePreview();
    previewRef.current = null;
    setPreviewUrl(null);
    setLastTap(null);
  }

  // Set while an upload is in flight, so the unmount below can hand
  // its preview to the board page instead of revoking it.
  const uploading = useRef(false);

  useEffect(
    () => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        const url = previewRef.current;
        if (uploading.current && url && photoMemory) {
          // Closed mid-upload (PIN-126): keep the local preview for
          // "Pin them" on the leftovers line. Same visit only, never
          // uploaded or stored; the board page revokes it.
          photoMemory.current = stashUploadingPhoto(photoMemory.current, url, revokeUrl);
          return;
        }
        releasePreview();
      };
    },
    // Unmount only; photoMemory is the board page's stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // "Pin them" opened before a mid-upload photo learned its job: show
  // it once it does, while this sheet is still on that photo.
  useEffect(() => {
    if (rememberedLive && previewRef.current === null && jobId === resumeJobId) {
      previewRef.current = rememberedLive;
      setPreviewUrl(rememberedLive);
    }
    // Only when the remembered photo changes, not on later resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rememberedLive]);

  // A batch step's preview lands once the driver downscales the file.
  useEffect(() => {
    if (batchPreviewUrl && previewRef.current === null) {
      previewRef.current = batchPreviewUrl;
      setPreviewUrl(batchPreviewUrl);
    }
  }, [batchPreviewUrl]);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      showPreview(file);
      setUploadPoolEmpty(false);
      setTapError("");
      const blob = await downscalePhoto(file, uploadMaxPx, uploadJpegQuality);
      const form = new FormData();
      form.set("photo", blob, "photo.jpg");
      const response = await fetch(`/api/boards/${encodeURIComponent(slug)}/photos`, {
        method: "POST",
        body: form,
      });
      const data = (await response.json()) as { job?: PublicJob; error?: string; code?: string };
      if (!response.ok && isPoolEmptyCode(data.code)) setUploadPoolEmpty(true);
      if (!response.ok || !data.job) throw new Error(data.error || t(locale, "add.failed"));
      return data.job;
    },
    onMutate: () => {
      uploading.current = true;
      const current = queryClient.getQueryData<BoardClientView>(boardQueryKey(slug));
      knownPinIds.current = new Set((current ?? boardView).pins.map((p) => p.id));
      setUploadError("");
      setSelected(new Set());
      setDropped(new Set());
      setPendingTapPin(null);
    },
    onSuccess: (job) => {
      setJobId(job.id);
      rememberPhoto(job.id);
    },
    onError: (cause) => {
      setUploadError(cause instanceof Error ? cause.message : t(locale, "add.failed"));
      // Closed mid-upload and it failed: nothing to resume, drop the preview.
      const url = previewRef.current;
      if (!mounted.current && url && photoMemory) {
        photoMemory.current = dropStashedPhoto(photoMemory.current, url, revokeUrl);
      }
    },
    onSettled: () => {
      uploading.current = false;
    },
  });

  const jobQuery = useQuery({
    queryKey: ["board-job", slug, jobId],
    queryFn: async (): Promise<JobView> => {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(jobId ?? "")}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as JobView & { error?: string };
      if (!response.ok) throw new Error(data.error || t(locale, "add.failed"));
      return data;
    },
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data && isTerminalJob(query.state.data.job.status) ? false : jobPollIntervalMs,
  });

  const job = jobQuery.data?.job ?? null;
  // Arrival order, like the board-poll pop-ins, so the review row
  // never reshuffles the stickers the photo just showed.
  const jobPins = useMemo(
    () =>
      [...(jobQuery.data?.pins ?? [])].sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      ),
    [jobQuery.data],
  );
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
  // PIN-122: reopened from the leftovers line, the board view
  // already holds this photo's candidates (tagged with its job), so
  // the review shows them while the job view loads.
  const resuming = resumeJobId !== null && jobId === resumeJobId;
  const waitingForResume = resuming && !jobQuery.data;
  const resumePins = useMemo(
    () =>
      resumeJobId === null
        ? []
        : boardView.pins
            .filter((pin) => pin.status === "candidate" && pin.jobId === resumeJobId)
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    [boardView, resumeJobId],
  );
  // Keep the board-poll pop-ins on screen until the job view
  // actually lands; switching on jobId alone would blank the
  // sheet (and the selection) for one fetch.
  const candidatePins: BoardViewPin[] = jobQuery.data ? jobPins : waitingForResume ? resumePins : popInPins;
  const elementFor = (pin: BoardViewPin): CandidateElement | undefined =>
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
      if (!response.ok) throw new Error(data.error || t(locale, "add.pinFailed"));
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
      setUploadError(t(locale, "add.pinFailed"));
    },
    onSuccess: (_data, payload) => {
      // Pinned: that photo has no leftovers to come back to.
      if (photoMemory?.current?.jobId === payload.jobId) photoMemory.current = null;
      if (batch) {
        // The board page advances to the next photo (or closes).
        batch.onConfirmed(payload.jobId);
        return;
      }
      setJobId(null);
      onClose();
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) }),
  });

  const tapAdd = useMutation({
    // The job id travels in the mutation VARIABLES, captured at
    // tap time: callbacks must never bind a late-landing tap to
    // whatever jobId the latest render holds (Bugbot PIN-78).
    mutationFn: async (point: { x: number; y: number; jobId: string }) => {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(point.jobId)}/tap-add`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ x: point.x, y: point.y }),
        },
      );
      const data = (await response.json()) as { error?: string; pin?: { id: string } };
      if (!response.ok) throw new Error(data.error || t(locale, "add.tapFailed"));
      return data;
    },
    onMutate: (point) => {
      setLastTap({ x: point.x, y: point.y });
      setTapError("");
    },
    onSuccess: (data, point) => {
      if (data.pin?.id) {
        setPendingTapPin({ pinId: data.pin.id, jobId: point.jobId, at: Date.now() });
      }
    },
    onError: (cause) =>
      setTapError(cause instanceof Error ? cause.message : t(locale, "add.tapFailed")),
    onSettled: (_data, _cause, point) => {
      // The job poll stops at terminal status, so pull the new
      // candidate (or the gone-copy flag) in explicitly.
      void queryClient.invalidateQueries({ queryKey: ["board-job", slug, point.jobId] });
      void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) });
    },
  });

  const batchBusy = batch?.itemStatus === "queued" || batch?.itemStatus === "uploading";
  const batchEnded =
    batch?.itemStatus === "failed" ||
    batch?.itemStatus === "refused" ||
    batch?.itemStatus === "stopped";
  const stageFromJob = addSheetStage({
    uploadPending: upload.isPending || batchBusy,
    jobId,
    // A reopened photo is reviewed at once; its job view corrects it.
    // In a batch step the job may not exist yet (still uploading):
    // that reads as finding, never as a phantom ready review.
    jobStatus: job?.status ?? (batch ? null : waitingForResume ? "ready" : null),
    candidateCount: candidatePins.length,
  });
  // A batch item that stopped/failed before a job existed (pool
  // empty, intake, transport) is an ended step: retry or skip.
  const stage =
    batchEnded && candidatePins.length === 0 && stageFromJob !== "review"
      ? "ended"
      : stageFromJob;
  // Its working copy expired or was deleted: no photo, no tap-to-add.
  const photoGone = job?.workingCopyGone === true;
  const payload = jobId ? confirmPayload(jobId, selected) : null;
  const awaitingTap = isAwaitingTapPin(pendingTapPin, jobId, candidateIds, jobQuery.errorUpdatedAt);
  const canPin =
    // Never pin while a tap is cutting or its candidate has
    // not landed in the job view yet: selected only gains the
    // tap pin then, and confirm drops unlisted job pins. Scoped
    // to that one pin — background refetches never disable Pin.
    payload !== null &&
    canConfirmJob(job?.status ?? null, candidatePins.length) &&
    !confirm.isPending &&
    !tapAdd.isPending &&
    !awaitingTap;
  const showFaceNote = shouldShowFaceNote(job?.faceNote ?? false, jobId, dismissedFaceJobId);
  // Visibility excludes `busy` so the photo stays tappable-looking
  // (disabled) while a tap is cutting; canTapAdd's busy gate is
  // unit-tested.
  const showTap = canTapAdd({
    jobStatus: job?.status ?? null,
    workingCopyGone: job?.workingCopyGone ?? false,
    hasPreview: previewUrl !== null,
    elementCount: job?.elementIds?.length ?? candidatePins.length,
    maxElements: elementsPerPhotoMax,
    busy: false,
  });
  const tapWorking = tapAdd.isPending || awaitingTap;

  // Cut-out moment: while the job runs, every landed candidate sits
  // on the photo at its maskBox; the newest is still "cutting".
  const progress = cuttingProgress(candidatePins, stage === "cutting");
  const placed: LiftedSticker[] =
    stage === "cutting"
      ? candidatePins.flatMap((pin) => {
          const element = elementFor(pin);
          const rect = element ? overlayRect(maskBoxOf(element)) : null;
          if (!element || !rect) return [];
          return [
            {
              id: pin.id,
              label: element.label,
              src: element.imageUrl,
              seed: pin.elementId,
              rect,
              cutting: pin.id === progress.cuttingId,
            },
          ];
        })
      : [];
  const spread = spreadLabels(placed.map((item) => item.rect));
  const lifted = placed.map((item, index) => ({ ...item, rect: spread[index] }));

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
    setTapError("");
    setPendingTapPin(null);
    clearPreview();
    upload.reset();
  }

  const stripView = libraryStripView({
    signedIn,
    status: library.status,
    cards: library.cards,
    board: boardView,
    local: library.states,
    max: libraryStripMax,
  });
  const onBoardFamilies = familiesOnBoard(library.cards ?? [], boardView);

  const title = seeAll
    ? t(locale, "add.allTitle")
    : stage === "review" && candidatePins.length > 0
      ? t(locale, "add.reviewTitle")
      : t(locale, "add.title");

  // "See all" opens only from the pick step, which has no footer.
  let footer: ReactNode = null;
  if (!seeAll && stage === "review") {
    footer = (
      <>
        {candidatePins.length > 0 ? (
          <Button
            variant="primary"
            size="lg"
            icon="pin"
            block
            disabled={!canPin}
            onClick={() => payload && confirm.mutate(payload)}
          >
            {confirm.isPending ? t(locale, "add.pinning") : tCount(locale, "add.pinCount", selected.size)}
          </Button>
        ) : null}
        {batch ? (
          <Button variant="quiet" className="pn-add-another" onClick={batch.onSkip}>
            {t(locale, "add.skipPhoto")}
          </Button>
        ) : (
          <Button
            variant={candidatePins.length > 0 ? "quiet" : "secondary"}
            icon={candidatePins.length > 0 ? undefined : "camera"}
            block={candidatePins.length === 0}
            className="pn-add-another"
            onClick={resetForAnother}
          >
            {t(locale, "add.another")}
          </Button>
        )}
      </>
    );
  } else if (!seeAll && stage === "ended") {
    footer = batch ? (
      <>
        <Button variant="primary" size="lg" block onClick={batch.onRetry}>
          {t(locale, "add.retryPhoto")}
        </Button>
        <Button variant="quiet" className="pn-add-another" onClick={batch.onSkip}>
          {t(locale, "add.skipPhoto")}
        </Button>
      </>
    ) : (
      <Button variant="primary" size="lg" icon="camera" block onClick={resetForAnother}>
        {t(locale, "add.another")}
      </Button>
    );
  } else if (!seeAll && batch && (stage === "finding" || stage === "cutting")) {
    // Still cutting: pinning waits for ready (confirm 409s a running
    // job). Skipping leaves the job running; its candidates become
    // leftovers the board can resume.
    footer = (
      <Button variant="secondary" block onClick={batch.onSkip}>
        {t(locale, "add.skipPhoto")}
      </Button>
    );
  }

  // PIN-152: out of makes — the copy names the fix, and the
  // button opens the buy sheet while buying can work.
  const jobPoolEmpty = job?.status === "failed" && isPoolEmptyCode(job.errorCode);
  // PIN-180: the day's AI budget / call limit / switch closed the namer or
  // the cutter: say so instead of the generic "didn't work".
  const budgetDenial = job?.status === "failed" ? aiBudgetDenial(job.errorCode) : null;
  const failedLine = t(locale, budgetDenial === "off" ? "ai.budgetOff" : budgetDenial === "exhausted" ? "ai.budgetExhausted" : "add.failed");
  const batchPoolEmpty = isPoolEmptyCode(batch?.errorCode);
  const batchCounts = batch
    ? {
        ready: batch.states.filter((s) => s === "ready" || s === "done").length,
        waiting: batch.states.filter((s) => s === "queued" || s === "uploading").length,
        failed: batch.states.filter((s) => s === "failed" || s === "refused" || s === "stopped").length,
      }
    : null;
  const batchSummary = batchCounts
    ? formatList(
        locale,
        [
          batchCounts.ready > 0 ? tCount(locale, "add.batchReadyCount", batchCounts.ready) : null,
          batchCounts.waiting > 0 ? tCount(locale, "add.batchWaitingCount", batchCounts.waiting) : null,
          batchCounts.failed > 0 ? tCount(locale, "add.batchFailedCount", batchCounts.failed) : null,
        ].filter((part): part is string => part !== null),
      )
    : "";
  const outOfMakes = (
    <>
      <SheetLine tone="error">{t(locale, "makes.poolEmptyPhoto")}</SheetLine>
      {onAddMakes ? (
        <Button variant="primary" onClick={onAddMakes}>
          {t(locale, "makes.add")}
        </Button>
      ) : null}
    </>
  );

  const photoContent = (
    <>
      {batch ? (
        <p className="pn-add-help" role="status">
          {tf(locale, "add.photoStep", { i: batch.index, n: batch.total })}
          {batchSummary ? ` · ${batchSummary}` : ""}
        </p>
      ) : null}
      {batch && batch.droppedCount > 0 ? (
        <SheetLine>{tCount(locale, "add.droppedPhotos", batch.droppedCount)}</SheetLine>
      ) : null}

      {stage === "pick" ? (
        <PhotoPick
          onFiles={(files) => {
            if (onPickFiles) onPickFiles(files);
            else if (files[0]) upload.mutate(files[0]);
          }}
        />
      ) : null}

      {stage === "pick" && stripView.kind !== "hidden" ? (
        <LibraryStrip
          view={stripView}
          headingId={stripHeadingId}
          seeAllId={seeAllId}
          onPin={library.pin}
          onSeeAll={() => setSeeAll(true)}
          onRetry={library.retry}
        />
      ) : null}

      {showFaceNote ? (
        <Hint point="none" dismissLabel={t(locale, "add.gotIt")} onDismiss={() => setDismissedFaceJobId(jobId)}>
          {t(locale, "add.faceNote")}
        </Hint>
      ) : null}

      {stage !== "pick" && previewUrl && !photoGone ? (
        <CutPhoto
          src={previewUrl}
          stage={stage}
          lifted={lifted}
          lastTap={lastTap}
          tap={
            stage === "review" && showTap
              ? {
                  working: tapWorking,
                  disabled: tapAdd.isPending || confirm.isPending,
                  onTap: (point) => {
                    if (jobId) tapAdd.mutate({ ...point, jobId });
                  },
                }
              : null
          }
        />
      ) : null}

      {stage === "review" && photoGone && candidatePins.length > 0 ? <SheetLine>{t(locale, "add.photoGone")}</SheetLine> : null}
      {resuming && jobQuery.isError && !jobQuery.data && !batchBusy && !batchEnded ? (
        <SheetLine tone="error">{t(locale, "add.resumeFailed")}</SheetLine>
      ) : null}
      {stage === "review" && candidatePins.length === 0 ? <SheetLine>{t(locale, "add.noneFound")}</SheetLine> : null}
      {stage === "finding" ? <CutStatus tag={t(locale, "cutout.findingTag")}>{t(locale, "add.finding")}</CutStatus> : null}
      {stage === "cutting" ? (
        <CutStatus tag={t(locale, "cutout.cuttingTag")}>
          {progress.ready === 0
            ? t(locale, "cutout.cuttingFirst")
            : tCount(locale, "cutout.readySoFar", progress.ready)}
        </CutStatus>
      ) : null}

      {stage === "review" && showTap ? (
        tapWorking ? (
          <CutStatus tag={t(locale, "cutout.cuttingTag")}>{t(locale, "add.tapWorking")}</CutStatus>
        ) : (
          <p className="pn-add-tapline">
            <Icon name="tap" size={20} />
            {t(locale, "add.tapHint")}
          </p>
        )
      ) : null}
      {tapError ? <SheetLine tone="error">{tapError}</SheetLine> : null}

      {stage === "review" && candidatePins.length > 0 ? (
        <div className="pn-add-review">
          <ul className="pn-pins pn-add-keep">
            {candidatePins.map((pin) => {
              const element = elementFor(pin);
              if (!element) return null;
              // Display follows the explicit drops so a just-landed
              // candidate never flashes "dropped" before the
              // selection effect adds it; the payload is `selected`.
              return (
                <Pin
                  as="li"
                  key={pin.id}
                  src={element.imageUrl}
                  label={element.label}
                  owner={{ id: meId, name: t(locale, "add.you") }}
                  seed={pin.elementId}
                  state={dropped.has(pin.id) ? "dropped" : "rest"}
                  onToggle={() => toggle(pin.id)}
                  pressedWhenRest
                />
              );
            })}
          </ul>
          <p className="pn-add-help" aria-live="polite">
            {reviewHelpLine(reviewHelp(candidatePins.length, candidatePins.filter((pin) => dropped.has(pin.id)).length), locale)}
          </p>
        </div>
      ) : null}

      {/* Failed after some things landed: the review offers those, no error line. */}
      {job?.status === "failed" && candidatePins.length === 0 ? (
        jobPoolEmpty ? outOfMakes : <SheetLine tone="error">{failedLine}</SheetLine>
      ) : null}
      {job?.status === "refused" ? <SheetLine>{t(locale, "add.refused")}</SheetLine> : null}
      {batch && batchEnded && !job && candidatePins.length === 0 ? (
        batchPoolEmpty ? (
          outOfMakes
        ) : (
          <SheetLine tone="error">{batch.error || t(locale, "add.failed")}</SheetLine>
        )
      ) : null}
      {uploadError ? (uploadPoolEmpty ? outOfMakes : <SheetLine tone="error">{uploadError}</SheetLine>) : null}
    </>
  );

  return (
    // No own data-theme: the sheet renders inside the board's skin root,
    // so it wears whatever look the board shows (a try-on included).
    <div className="pn-add-root">
      <Sheet title={title} onClose={onClose} closeLabel={t(locale, "add.close")} footer={footer} className="pn-add-sheet">
        {seeAll ? (
          <>
            <Button
              variant="quiet"
              size="sm"
              icon="back"
              className="pn-add-back"
              autoFocus
              onClick={() => {
                focusSeeAll.current = true;
                setSeeAll(false);
              }}
            >
              {t(locale, "add.back")}
            </Button>
            <LibraryList
              status={library.status}
              cards={library.cards}
              stateOf={(card) => libraryPinState(card, library.states, onBoardFamilies)}
              onPin={library.pin}
              onRetry={library.retry}
            />
          </>
        ) : (
          photoContent
        )}
      </Sheet>
    </div>
  );
}
