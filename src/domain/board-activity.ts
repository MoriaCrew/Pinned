/**
 * Activity strip lines (PIN-74, docs/11 section 5.4): pure
 * projection of BoardEvent into what the board page shows.
 * Only board-visible moments appear: a participant joining, a
 * pin landing (pin_added — element_added is a private candidate
 * until confirmed, so it never renders), and a scene finishing
 * (scene_ready — requested/refused/failed already have their
 * own gallery cards). Names/labels resolve against the board's
 * public roster/elements; a pin whose element was deleted is
 * skipped rather than shown with an invented label.
 */
import type { BoardEvent } from "./board";

export type ActivityKind = "joined" | "pinned" | "sceneReady";

export interface ActivityLine {
  /** BoardEvent id — stable React key. */
  id: string;
  kind: ActivityKind;
  /** Actor display name; null when no longer on the roster. */
  actorName: string | null;
  /** Element label for "pinned" lines; null otherwise. */
  label: string | null;
  createdAt: number;
}

export function activityLines(
  events: readonly BoardEvent[],
  participants: readonly { id: string; displayName: string }[],
  elements: readonly { id: string; label: string }[],
  max: number,
): ActivityLine[] {
  if (max <= 0) return [];
  const namesById = new Map(participants.map((p) => [p.id, p.displayName]));
  const labelsById = new Map(elements.map((e) => [e.id, e.label]));
  const lines: (ActivityLine & { order: number })[] = [];
  events.forEach((event, index) => {
    const actorName = namesById.get(event.actorId) ?? null;
    if (event.type === "participant_joined") {
      lines.push({ id: event.id, kind: "joined", actorName, label: null, createdAt: event.createdAt, order: index });
    } else if (event.type === "pin_added") {
      const label = event.elementId ? labelsById.get(event.elementId) : undefined;
      if (label === undefined) return;
      lines.push({ id: event.id, kind: "pinned", actorName, label, createdAt: event.createdAt, order: index });
    } else if (event.type === "scene_ready") {
      lines.push({ id: event.id, kind: "sceneReady", actorName, label: null, createdAt: event.createdAt, order: index });
    }
  });
  // Newest first; append order breaks createdAt ties.
  lines.sort((a, b) => b.createdAt - a.createdAt || b.order - a.order);
  return lines.slice(0, max).map(({ order: _order, ...line }) => line);
}
