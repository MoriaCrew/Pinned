/**
 * Leftovers (PIN-122): candidate pins from a photo whose review
 * sheet closed before "Pin N things". Only their uploader sees
 * them (the board view filters candidates), and since PIN-122 the
 * board view tags each of the viewer's own candidates with its
 * photo's job id. The board shows one line instead of putting them
 * in the grid: Pin them reopens the newest photo's review, Clear
 * drops them. Pure; the board page renders what this returns.
 */
import type { BoardViewPin } from "./board-view";

export interface LeftoverGroup {
  jobId: string;
  /** Arrival order, like the Add sheet's review row. */
  pinIds: string[];
  elementIds: string[];
  /** Newest candidate's createdAt: orders photos newest first. */
  newestAt: number;
}

export interface Leftovers {
  /** One group per photo, newest photo first. */
  groups: LeftoverGroup[];
  /** Every leftover across all photos. */
  count: number;
}

const NONE: Leftovers = { groups: [], count: 0 };

/**
 * The viewer's leftovers grouped by photo job. Pins without a job
 * id (someone else's, pinned ones, or an older server) are not
 * leftovers this viewer can finish, so they are left out.
 */
export function leftoversOf(view: { pins: readonly BoardViewPin[] }, meId: string | null | undefined): Leftovers {
  if (!meId) return NONE;
  const byJob = new Map<string, BoardViewPin[]>();
  for (const pin of view.pins) {
    if (pin.status !== "candidate" || pin.pinnedBy !== meId || !pin.jobId) continue;
    const list = byJob.get(pin.jobId) ?? [];
    list.push(pin);
    byJob.set(pin.jobId, list);
  }
  if (byJob.size === 0) return NONE;
  const groups: LeftoverGroup[] = [...byJob.entries()].map(([jobId, pins]) => {
    const ordered = [...pins].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return {
      jobId,
      pinIds: ordered.map((pin) => pin.id),
      elementIds: ordered.map((pin) => pin.elementId),
      newestAt: Math.max(...ordered.map((pin) => pin.createdAt)),
    };
  });
  groups.sort((a, b) => b.newestAt - a.newestAt || a.jobId.localeCompare(b.jobId));
  return { groups, count: groups.reduce((sum, group) => sum + group.pinIds.length, 0) };
}

/** Optimistic board after Clear: those photos' candidates leave the view. */
export function withoutLeftovers<V extends { pins: readonly BoardViewPin[] }>(
  view: V,
  groups: readonly LeftoverGroup[],
): V {
  const cleared = new Set(groups.flatMap((group) => group.pinIds));
  return { ...view, pins: view.pins.filter((pin) => !cleared.has(pin.id)) };
}
