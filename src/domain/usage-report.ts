/**
 * Usage counts for the hackathon video (PIN-74): the honest read
 * model is the per-board counters the repository already keeps
 * (docs/11 section 5.4), read through the public board view.
 * There is deliberately no global board list — slugs are
 * capability secrets — so totals aggregate the boards the
 * operator names (scripts/usage-report.mjs mirrors this file).
 */

export interface BoardUsage {
  title: string;
  participants: number;
  elements: number;
  pins: number;
  scenes: number;
}

export interface UsageTotals {
  boards: number;
  people: number;
  elements: number;
  pins: number;
  scenes: number;
}

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/** One board's counts from a public board view; null if malformed. */
export function usageFromBoardView(view: unknown): BoardUsage | null {
  if (typeof view !== "object" || view === null) return null;
  const board = (view as Record<string, unknown>).board;
  if (typeof board !== "object" || board === null) return null;
  const { title, counters } = board as Record<string, unknown>;
  if (typeof title !== "string" || typeof counters !== "object" || counters === null) {
    return null;
  }
  const c = counters as Record<string, unknown>;
  const participants = counter(c.participantCount);
  const elements = counter(c.elementCount);
  const pins = counter(c.pinCount);
  const scenes = counter(c.sceneCount);
  if (participants === null || elements === null || pins === null || scenes === null) {
    return null;
  }
  return { title, participants, elements, pins, scenes };
}

export function totalUsage(boards: readonly BoardUsage[]): UsageTotals {
  const totals: UsageTotals = { boards: 0, people: 0, elements: 0, pins: 0, scenes: 0 };
  for (const board of boards) {
    totals.boards += 1;
    totals.people += board.participants;
    totals.elements += board.elements;
    totals.pins += board.pins;
    totals.scenes += board.scenes;
  }
  return totals;
}
