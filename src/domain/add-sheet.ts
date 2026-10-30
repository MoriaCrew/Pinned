/**
 * Pure Add-sheet logic (PIN-67, docs/11 sections 5.8 + 6): client
 * downscale geometry, pre-selected candidate pins that pop in as
 * SAM lands, the "Pin N" payload, optimistic board updates and
 * the face consent note (once per photo, never blocking). PIN-99
 * adds the cut-out moment's step and sticker-on-photo geometry.
 */
import type { BoardViewLike, BoardViewPin } from "./board-view";

/** Target size for the client downscale; never upscales. */
export function downscaleTarget(
  width: number,
  height: number,
  maxPx: number,
): { width: number; height: number; scaled: boolean } {
  if (!(width > 0 && height > 0 && maxPx > 0)) {
    return { width: Math.max(0, width), height: Math.max(0, height), scaled: false };
  }
  const longest = Math.max(width, height);
  if (longest <= maxPx) return { width, height, scaled: false };
  const ratio = maxPx / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

/**
 * Candidates from the board poll that belong to the in-flight
 * photo: mine, still candidate, and not present before the upload
 * started. This is how pins pop in while the upload request (which
 * runs the job in-request) is still pending.
 */
export function newCandidatePins(
  view: BoardViewLike,
  meId: string,
  knownPinIds: ReadonlySet<string>,
): BoardViewPin[] {
  return view.pins
    .filter((pin) => pin.status === "candidate" && pin.pinnedBy === meId && !knownPinIds.has(pin.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Pre-select every candidate; keep explicit drops as pins pop in. */
export function selectionWithCandidates(
  selected: ReadonlySet<string>,
  dropped: ReadonlySet<string>,
  candidateIds: readonly string[],
): Set<string> {
  const next = new Set(selected);
  for (const id of dropped) next.delete(id);
  for (const id of candidateIds) {
    if (!dropped.has(id)) next.add(id);
  }
  for (const id of next) {
    if (!candidateIds.includes(id)) next.delete(id);
  }
  return next;
}

export function confirmPayload(
  jobId: string,
  selected: ReadonlySet<string>,
): { jobId: string; pinIds: string[] } | null {
  if (!jobId || selected.size === 0) return null;
  return { jobId, pinIds: [...selected] };
}

/**
 * Optimistic board view for "Pin N": selected candidates become
 * pinned, the job's dropped candidates leave the grid. Rollback
 * is the query cache snapshot (component side).
 */
export function applyOptimisticConfirm<V extends BoardViewLike>(
  view: V,
  jobPinIds: readonly string[],
  selected: ReadonlySet<string>,
): V {
  const jobPins = new Set(jobPinIds);
  return {
    ...view,
    pins: view.pins.flatMap((pin) => {
      if (!jobPins.has(pin.id)) return [pin];
      if (selected.has(pin.id)) return [{ ...pin, status: "pinned" as const }];
      return [];
    }),
  };
}

/**
 * Face consent note (Policy faces:"note", server sets job.faceNote):
 * shown once per photo/job until dismissed, and it never gates the
 * Pin button — people are allowed in pins (AGENTS privacy rule 6).
 */
export function shouldShowFaceNote(
  faceNote: boolean,
  jobId: string | null,
  dismissedJobId: string | null,
): boolean {
  return faceNote && jobId !== null && dismissedJobId !== jobId;
}

export type JobStatusLike = "pending" | "running" | "ready" | "failed" | "refused";

/**
 * Tap-to-add geometry (PIN-78): a tap on the photo preview
 * (rendered at natural aspect, so the element box IS the image
 * area) becomes a point normalized 0..1 — the Segmenter point
 * prompt convention (gateway ports). Outside / degenerate
 * boxes are null, never a guessed point.
 */
export function normalizedTapPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } | null {
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }
  return { x, y };
}

/**
 * When the Add sheet shows the tap surface (PIN-78): the job
 * landed (ready), its working copy is still alive (pre-confirm,
 * pre-TTL — hidden the moment the copy is gone), a photo
 * preview exists to tap on, the photo is not already at the
 * Policy elementsPerPhoto.max (tap-adds count), and no tap or
 * confirm is already in flight.
 */
export function canTapAdd(input: {
  jobStatus: JobStatusLike | null;
  workingCopyGone: boolean;
  hasPreview: boolean;
  elementCount: number;
  maxElements: number;
  busy: boolean;
}): boolean {
  return (
    input.jobStatus === "ready" &&
    !input.workingCopyGone &&
    input.hasPreview &&
    input.elementCount < input.maxElements &&
    !input.busy
  );
}

/**
 * True while a successful tap's candidate has not appeared in
 * the job view yet (PIN-78): Pin N must wait for it, because
 * confirm drops job pins missing from the payload — but ONLY
 * for that pin, on that job. A job refetch that fails after
 * the tap releases the wait (the pin is not visible to select
 * anyway) instead of wedging Pin disabled; background
 * refetches and stale pre-tap errors never affect it.
 */
/** A tap whose candidate has not landed in the job view yet. */
export interface PendingTapPin {
  pinId: string;
  jobId: string;
  /** Epoch-ms the tap succeeded (client clock). */
  at: number;
}

export function isAwaitingTapPin(
  pending: PendingTapPin | null,
  currentJobId: string | null,
  candidateIds: readonly string[],
  jobErrorUpdatedAt: number,
): boolean {
  if (!pending) return false;
  // A previous photo's pending tap never gates a new job.
  if (pending.jobId !== currentJobId) return false;
  if (candidateIds.includes(pending.pinId)) return false;
  // Only a refetch failure AFTER this tap releases the wait; a
  // stale error from before the tap must not skip it.
  if (jobErrorUpdatedAt > pending.at) return false;
  return true;
}

export function isTerminalJob(status: JobStatusLike): boolean {
  return status === "ready" || status === "failed" || status === "refused";
}

/**
 * The cut-out moment's steps (PIN-99, docs/14): pick a photo,
 * finding (upload / job running, nothing cut yet), cutting
 * (candidates arriving on the photo), review (job ready: keep or
 * drop, tap to add) and ended (failed or refused). A ready job
 * with no candidates is still review: tap-to-add is the fix.
 */
export type AddStage = "pick" | "finding" | "cutting" | "review" | "ended";

export function addSheetStage(input: {
  uploadPending: boolean;
  jobId: string | null;
  /** null while the job view has not landed yet. */
  jobStatus: JobStatusLike | null;
  candidateCount: number;
}): AddStage {
  if (!input.uploadPending && input.jobId === null) return "pick";
  if (input.jobStatus === "ready") return "review";
  if (input.jobStatus === "failed" || input.jobStatus === "refused") return "ended";
  return input.candidateCount > 0 ? "cutting" : "finding";
}

/**
 * While the job still runs, the newest candidate is drawn as the
 * one being cut and the others as lifted; `ready` counts the
 * lifted ones for the status line. Once the job is done nothing
 * is cutting and every candidate counts.
 */
export function cuttingProgress(
  pins: readonly { id: string; createdAt: number }[],
  running: boolean,
): { cuttingId: string | null; ready: number } {
  if (!running || pins.length === 0) return { cuttingId: null, ready: pins.length };
  let newest = pins[0];
  for (const pin of pins) {
    if (pin.createdAt > newest.createdAt || (pin.createdAt === newest.createdAt && pin.id > newest.id)) {
      newest = pin;
    }
  }
  return { cuttingId: newest.id, ready: pins.length - 1 };
}

/** Element.maskBox as the public API sends it: normalized 0..1 corners. */
export interface MaskBoxLike {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Smallest overlay side (fraction of the photo) so a tiny cut-out
 * still reads as a sticker; a visual floor, not a Policy limit.
 */
export const MIN_OVERLAY_FRACTION = 0.08;
/** Name labels stay this far from the photo's sides (fraction). */
export const LABEL_EDGE_FRACTION = 0.18;
/** Boxes this close to the top get their name label below. */
export const LABEL_ROOM_FRACTION = 0.14;

export interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Name label anchor (fractions of the photo box). */
  label: { x: number; y: number; below: boolean };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function span(a: number, b: number, minSize: number): { start: number; size: number } {
  const lo = clamp(Math.min(a, b), 0, 1);
  const hi = clamp(Math.max(a, b), 0, 1);
  const size = Math.max(hi - lo, minSize);
  const center = (lo + hi) / 2;
  return { start: clamp(center - size / 2, 0, 1 - size), size };
}

/**
 * Where a candidate's sticker sits on the photo (PIN-99): its
 * maskBox clamped to the photo, swapped corners fixed, grown to a
 * minimum size around its centre and kept inside. Missing or
 * non-finite boxes (e.g. a library copy without one) are null,
 * never a guessed spot.
 */
export function overlayRect(
  box: MaskBoxLike | null | undefined,
  minSize: number = MIN_OVERLAY_FRACTION,
): OverlayRect | null {
  if (!box) return null;
  const { x1, y1, x2, y2 } = box;
  if (![x1, y1, x2, y2].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const floor = clamp(minSize, 0, 1);
  const x = span(x1, x2, floor);
  const y = span(y1, y2, floor);
  const below = y.start < LABEL_ROOM_FRACTION;
  return {
    left: x.start,
    top: y.start,
    width: x.size,
    height: y.size,
    label: {
      x: clamp(x.start + x.size / 2, LABEL_EDGE_FRACTION, 1 - LABEL_EDGE_FRACTION),
      y: below ? y.start + y.size : y.start,
      below,
    },
  };
}

/** Name labels closer than this across (fraction of the photo) can touch. */
export const LABEL_GAP_FRACTION = 0.3;
/** A name label's height as a fraction of the photo, roughly. */
export const LABEL_ROW_FRACTION = 0.1;

function labelCenterY(label: OverlayRect["label"]): number {
  return label.below ? label.y + LABEL_ROW_FRACTION / 2 : label.y - LABEL_ROW_FRACTION / 2;
}

/**
 * Keeps name labels from sitting on top of each other (PIN-99): in
 * arrival order, a label that would touch an earlier one moves to
 * the other side of its own sticker when that side is free (and,
 * going up, when there is room above it inside the photo).
 */
export function spreadLabels(rects: readonly OverlayRect[]): OverlayRect[] {
  const placed: OverlayRect["label"][] = [];
  const collides = (label: OverlayRect["label"]) =>
    placed.some(
      (other) =>
        Math.abs(other.x - label.x) < LABEL_GAP_FRACTION &&
        Math.abs(labelCenterY(other) - labelCenterY(label)) < LABEL_ROW_FRACTION,
    );
  return rects.map((rect) => {
    let label = rect.label;
    const roomAbove = rect.top >= LABEL_ROOM_FRACTION;
    if (collides(label) && (label.below ? roomAbove : true)) {
      const below = !label.below;
      const flipped = { x: label.x, y: below ? rect.top + rect.height : rect.top, below };
      if (!collides(flipped)) label = flipped;
    }
    placed.push(label);
    return label === rect.label ? rect : { ...rect, label };
  });
}

/** Reads a maskBox off an API element that may not carry one. */
export function maskBoxOf(element: unknown): MaskBoxLike | null {
  if (typeof element !== "object" || element === null) return null;
  const box = (element as { maskBox?: unknown }).maskBox;
  if (typeof box !== "object" || box === null) return null;
  const { x1, y1, x2, y2 } = box as Record<string, unknown>;
  if (typeof x1 !== "number" || typeof y1 !== "number" || typeof x2 !== "number" || typeof y2 !== "number") {
    return null;
  }
  return { x1, y1, x2, y2 };
}
