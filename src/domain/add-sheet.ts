/**
 * Pure Add-sheet logic (PIN-67, docs/11 sections 5.8 + 6): client
 * downscale geometry, pre-selected candidate pins that pop in as
 * SAM lands, the "Pin N" payload, optimistic board updates and
 * the face consent note (once per photo, never blocking).
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
 * for that pin. A failed job refetch releases the wait (the
 * pin is not visible to select anyway) instead of wedging Pin
 * disabled on every background refetch.
 */
export function isAwaitingTapPin(
  pendingTapPinId: string | null,
  candidateIds: readonly string[],
  jobQueryFailed: boolean,
): boolean {
  return (
    pendingTapPinId !== null &&
    !candidateIds.includes(pendingTapPinId) &&
    !jobQueryFailed
  );
}

export function isTerminalJob(status: JobStatusLike): boolean {
  return status === "ready" || status === "failed" || status === "refused";
}
