/**
 * Demo-board seed plan (PIN-73, docs/11 Q8 default).
 *
 * Pure data + helpers shared by scripts/seed-demo-board.mjs (which
 * mirrors these constants — scripts stay dependency-free .mjs) and
 * its unit tests. The plan is synthetic-only: two PIN-50 fixture
 * photos, one per demo participant.
 *
 * Reset semantics: there is no delete API, so a "reset" is a NEW
 * board with the same deterministic title marker; the operator
 * repoints DEMO_BOARD_SLUG / the Linear evidence note. Two runs
 * against the same target must produce the same counts
 * (participants / pinned pins / elements / ready scenes).
 */

/** Deterministic title marker identifying seeded demo boards. */
export const DEMO_BOARD_TITLE = "Pinneds demo board (seeded, synthetic)";
export const DEMO_BOARD_THEME_ID = "cat";

export interface DemoParticipantPlan {
  displayName: string;
  /** Path relative to the repo root (PIN-50 synthetic fixture). */
  photoPath: string;
}

export const DEMO_PARTICIPANTS: readonly DemoParticipantPlan[] = [
  {
    displayName: "Demo Mia",
    photoPath: "eval/fixtures/studio/photos/desk-mug-duck.jpg",
  },
  {
    displayName: "Demo Sam",
    photoPath: "eval/fixtures/studio/photos/shelf-clock-books.jpg",
  },
] as const;

/** Harmless prompt mixing items from both demo photos. */
export const DEMO_SCENE_PROMPT =
  "These things having a tiny tea party on a sunny windowsill";

/** Display name used by the fresh-visitor first-scene timing run. */
export const DEMO_TIMING_VISITOR_NAME = "Demo Visitor";

export function isDemoBoardTitle(title: string): boolean {
  return title === DEMO_BOARD_TITLE;
}

export interface SeedCounts {
  participants: number;
  pinnedPins: number;
  elements: number;
  readyScenes: number;
}

interface BoardViewLike {
  participants?: unknown[];
  pins?: { status?: string }[];
  elements?: unknown[];
  scenes?: { status?: string }[];
}

/** Counts from a public board view (GET /api/boards/{slug}). */
export function summarizeSeedCounts(view: BoardViewLike): SeedCounts {
  return {
    participants: view.participants?.length ?? 0,
    pinnedPins: (view.pins ?? []).filter((p) => p.status === "pinned").length,
    elements: view.elements?.length ?? 0,
    readyScenes: (view.scenes ?? []).filter((s) => s.status === "ready").length,
  };
}

export function sameSeedCounts(a: SeedCounts, b: SeedCounts): boolean {
  return (
    a.participants === b.participants &&
    a.pinnedPins === b.pinnedPins &&
    a.elements === b.elements &&
    a.readyScenes === b.readyScenes
  );
}

interface ElementLike {
  id: string;
  ownerId?: string;
}

/**
 * Pick scene element ids: one per owner first (so the demo scene
 * visibly mixes both participants' things), then fill in order,
 * capped at `max` (callers pass Policy.pinsPerScene.max).
 */
export function pickSceneElementIds(
  elements: readonly ElementLike[],
  max: number,
): string[] {
  if (max <= 0) return [];
  const picked: string[] = [];
  const seenOwners = new Set<string>();
  for (const el of elements) {
    if (picked.length >= max) break;
    const owner = el.ownerId ?? "";
    if (!seenOwners.has(owner)) {
      seenOwners.add(owner);
      picked.push(el.id);
    }
  }
  for (const el of elements) {
    if (picked.length >= max) break;
    if (!picked.includes(el.id)) picked.push(el.id);
  }
  return picked;
}
