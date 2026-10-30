"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addSheetStage,
  applyOptimisticConfirm,
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
  selectionWithCandidates,
  shouldShowFaceNote,
  spreadLabels,
  type AddStage,
  type JobStatusLike,
  type MaskBoxLike,
  type OverlayRect,
  type PendingTapPin,
} from "../../../domain/add-sheet";
import type { BoardViewElement, BoardViewPin } from "../../../domain/board-view";
import { t, tCount } from "../../../i18n";
import { Button, Hint, Icon, Pin, Sheet, Sticker, Tag, cx } from "../../../ui";
import type { BoardClientView } from "./BoardClient";
import { useAuth } from "../../auth/AuthProvider";
import { LibraryTab } from "./LibraryTab";

interface PublicJob {
  id: string;
  status: JobStatusLike;
  faceNote: boolean;
  pinIds: string[];
  elementIds?: string[];
  workingCopyGone?: boolean;
}

/** The public element payload carries its maskBox (PIN-99); library copies may not. */
type CandidateElement = BoardViewElement & { maskBox?: MaskBoxLike };

interface JobView {
  job: PublicJob;
  pins: (BoardViewPin & { boardId: string })[];
  elements: (CandidateElement & { flattenedUrl: string; createdAt: number })[];
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
  const [ratio, setRatio] = useState<number | null>(null);
  const style = ratio ? ({ "--ratio": ratio } as CSSProperties) : undefined;
  return (
    <div className="pn-cut-photo" data-stage={stage} data-working={tap?.working ? "" : undefined} style={style}>
      <div className="pn-cut-frame">
        {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview of the picked file */}
        <img
          src={src}
          alt={t("en", "add.photoAlt")}
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
            aria-label={t("en", "add.tapHint")}
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
 * blocks pinning.
 */
export function AddSheet({
  slug,
  meId,
  boardView,
  uploadMaxPx,
  uploadJpegQuality,
  jobPollIntervalMs,
  elementsPerPhotoMax,
  onClose,
}: {
  slug: string;
  meId: string;
  boardView: BoardClientView;
  uploadMaxPx: number;
  uploadJpegQuality: number;
  jobPollIntervalMs: number;
  elementsPerPhotoMax: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // PIN-85: "From my pins" library tab. Disabled auth (link-only
  // or signed out) keeps the photo-only sheet.
  const auth = useAuth();
  const [tab, setTab] = useState<"photo" | "library">("photo");
  const showLibraryTab = auth.enabled && auth.status === "signedIn";
  const [jobId, setJobId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [dismissedFaceJobId, setDismissedFaceJobId] = useState<string | null>(null);
  const knownPinIds = useRef<ReadonlySet<string>>(new Set(boardView.pins.map((p) => p.id)));
  // Tap-to-add (PIN-78): the preview is a LOCAL object URL of the
  // picked file (never uploaded/stored as-is; the server segments
  // its own stripped working copy). Photo intake auto-rotates and
  // browsers apply EXIF orientation to <img>, so normalized tap
  // points line up with the working copy's frame.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const [tapError, setTapError] = useState("");
  const [lastTap, setLastTap] = useState<{ x: number; y: number } | null>(null);
  const [pendingTapPin, setPendingTapPin] = useState<PendingTapPin | null>(null);
  const tabsId = useId();

  function showPreview(file: File) {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const url = URL.createObjectURL(file);
    previewRef.current = url;
    setPreviewUrl(url);
  }

  function clearPreview() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreviewUrl(null);
    setLastTap(null);
  }

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  const upload = useMutation({
    mutationFn: async (file: File) => {
      showPreview(file);
      setTapError("");
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
      setPendingTapPin(null);
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
  // Keep the board-poll pop-ins on screen until the job view
  // actually lands; switching on jobId alone would blank the
  // sheet (and the selection) for one fetch.
  const candidatePins: BoardViewPin[] = jobQuery.data ? jobPins : popInPins;
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
      if (!response.ok) throw new Error(data.error || t("en", "add.pinFailed"));
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
      setUploadError(t("en", "add.pinFailed"));
    },
    onSuccess: () => {
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
      if (!response.ok) throw new Error(data.error || t("en", "add.tapFailed"));
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
      setTapError(cause instanceof Error ? cause.message : t("en", "add.tapFailed")),
    onSettled: (_data, _cause, point) => {
      // The job poll stops at terminal status, so pull the new
      // candidate (or the gone-copy flag) in explicitly.
      void queryClient.invalidateQueries({ queryKey: ["board-job", slug, point.jobId] });
      void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) });
    },
  });

  const stage = addSheetStage({
    uploadPending: upload.isPending,
    jobId,
    jobStatus: job?.status ?? null,
    candidateCount: candidatePins.length,
  });
  const payload = jobId ? confirmPayload(jobId, selected) : null;
  const awaitingTap = isAwaitingTapPin(pendingTapPin, jobId, candidateIds, jobQuery.errorUpdatedAt);
  const canPin =
    // Never pin while a tap is cutting or its candidate has
    // not landed in the job view yet: selected only gains the
    // tap pin then, and confirm drops unlisted job pins. Scoped
    // to that one pin — background refetches never disable Pin.
    payload !== null &&
    job?.status === "ready" &&
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

  const onPhotoTab = !showLibraryTab || tab === "photo";
  const title = onPhotoTab && stage === "review" && candidatePins.length > 0 ? t("en", "add.reviewTitle") : t("en", "add.title");

  let footer: ReactNode = null;
  if (onPhotoTab && stage === "review") {
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
            {confirm.isPending ? t("en", "add.pinning") : tCount("en", "add.pinCount", selected.size)}
          </Button>
        ) : null}
        <Button
          variant={candidatePins.length > 0 ? "quiet" : "secondary"}
          icon={candidatePins.length > 0 ? undefined : "camera"}
          block={candidatePins.length === 0}
          className="pn-add-another"
          onClick={resetForAnother}
        >
          {t("en", "add.another")}
        </Button>
      </>
    );
  } else if (onPhotoTab && stage === "ended") {
    footer = (
      <Button variant="primary" size="lg" icon="camera" block onClick={resetForAnother}>
        {t("en", "add.another")}
      </Button>
    );
  }

  const photoContent = (
    <>
      {stage === "pick" ? (
        <label className="pn-add-pick">
          <span className="pn-add-pick-icon" aria-hidden="true">
            <Icon name="camera" size={28} />
          </span>
          <span className="pn-add-pick-title">{t("en", "add.pick")}</span>
          <span className="pn-add-pick-help">{t("en", "add.pickHelp")}</span>
          <input
            type="file"
            accept="image/*"
            className="pn-sr"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) upload.mutate(file);
            }}
          />
        </label>
      ) : null}

      {showFaceNote ? (
        <Hint point="none" dismissLabel={t("en", "add.gotIt")} onDismiss={() => setDismissedFaceJobId(jobId)}>
          {t("en", "add.faceNote")}
        </Hint>
      ) : null}

      {stage !== "pick" && previewUrl ? (
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

      {stage === "review" && candidatePins.length === 0 ? <SheetLine>{t("en", "add.noneFound")}</SheetLine> : null}
      {stage === "finding" ? <CutStatus tag={t("en", "cutout.findingTag")}>{t("en", "add.finding")}</CutStatus> : null}
      {stage === "cutting" ? (
        <CutStatus tag={t("en", "cutout.cuttingTag")}>
          {progress.ready === 0
            ? t("en", "cutout.cuttingFirst")
            : tCount("en", "cutout.readySoFar", progress.ready)}
        </CutStatus>
      ) : null}

      {stage === "review" && showTap ? (
        tapWorking ? (
          <CutStatus tag={t("en", "cutout.cuttingTag")}>{t("en", "add.tapWorking")}</CutStatus>
        ) : (
          <p className="pn-add-tapline">
            <Icon name="tap" size={20} />
            {t("en", "add.tapHint")}
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
                  owner={{ id: meId, name: t("en", "add.you") }}
                  seed={pin.elementId}
                  state={dropped.has(pin.id) ? "dropped" : "rest"}
                  onToggle={() => toggle(pin.id)}
                  pressedWhenRest
                />
              );
            })}
          </ul>
          <p className="pn-add-help">{t("en", "add.tapDrop")}</p>
        </div>
      ) : null}

      {job?.status === "failed" ? <SheetLine tone="error">{t("en", "add.failed")}</SheetLine> : null}
      {job?.status === "refused" ? <SheetLine>{t("en", "add.refused")}</SheetLine> : null}
      {uploadError ? <SheetLine tone="error">{uploadError}</SheetLine> : null}
    </>
  );

  return (
    // No own data-theme: the sheet renders inside the board's skin root,
    // so it wears whatever look the board shows (a try-on included).
    <div className="pn-add-root">
      <Sheet title={title} onClose={onClose} closeLabel={t("en", "add.close")} footer={footer} className="pn-add-sheet">
        {showLibraryTab ? (
          <>
            <div className="pn-add-tabs" role="tablist" aria-label={t("en", "add.tabs")}>
              <button
                type="button"
                role="tab"
                id={`${tabsId}-photo`}
                aria-selected={tab === "photo"}
                aria-controls={`${tabsId}-panel`}
                className="pn-add-tab"
                onClick={() => setTab("photo")}
              >
                <Icon name="camera" size={18} />
                {t("en", "add.photoTab")}
              </button>
              <button
                type="button"
                role="tab"
                id={`${tabsId}-library`}
                aria-selected={tab === "library"}
                aria-controls={`${tabsId}-panel`}
                className="pn-add-tab"
                onClick={() => setTab("library")}
              >
                <Icon name="pin" size={18} />
                {t("en", "add.fromMyPins")}
              </button>
            </div>
            <div
              className="pn-add-panel"
              role="tabpanel"
              id={`${tabsId}-panel`}
              aria-labelledby={`${tabsId}-${tab}`}
            >
              {tab === "library" ? <LibraryTab slug={slug} /> : photoContent}
            </div>
          </>
        ) : (
          photoContent
        )}
      </Sheet>
    </div>
  );
}
