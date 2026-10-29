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

export function isTerminalJob(status: JobStatusLike): boolean {
  return status === "ready" || status === "failed" || status === "refused";
}
