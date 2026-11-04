import "server-only";
/**
 * The operator's side of Report & hold (PIN-272, ADR-004 decision 6,
 * docs/20): dismiss restores exactly what a report held, unless another
 * open report on the same board still needs it; takedown removes the
 * reported thing the way the product deletes (element cascade, scene
 * tombstone, board tombstone + unlink + storage sweep); the backstop
 * takes down the reports whose deadline passed, never an `illegal`
 * one. Storage temporary holds are released only by `releaseReportHolds`
 * (a dismiss, or the close-out of docs/20 §7), never by a takedown: a held object
 * refuses deletion, which is the point. Run through
 * `scripts/report-ops.ts`; never from a request.
 */
import { releaseRef, type Scene } from "../domain/board";
import type { BoardRepository } from "../domain/board-repository";
import type { ReportRecord } from "../domain/board-report";
import type { ReportStore } from "../domain/report-store";
import type { UserRepository } from "../domain/user-repository";
import { deleteSceneObjects } from "./board-api";
import { unlinkMyBoards } from "./board-delete";
import { listBoardObjectRefs, listTargetObjectRefs } from "./board-report";
import { elementBytesStillNeeded, sweepDeletedBoardStorage } from "./board-storage";
import type { DerivativeStore } from "./derivative-store";
import { logServerError } from "./safe-log";

export interface ReportDecideDeps {
  boards: BoardRepository;
  users: UserRepository;
  store: DerivativeStore;
  reports: ReportStore;
  now?: () => number;
}

export interface ReleasedCounts {
  elements: number;
  scenes: number;
  boardReview: boolean;
  storage: boolean;
}

export interface DismissOutcome {
  record: ReportRecord;
  released: ReleasedCounts;
}

/** A missing board (deleted meanwhile) reads as RangeError from the repository: the hold is moot. */
function isGoneBoard(error: unknown): boolean {
  return error instanceof RangeError;
}

export interface HoldReleaseResult {
  released: number;
  /** Objects left held: another report (open, or a confirmed takedown awaiting its close-out) still holds them as evidence. */
  kept: number;
  failed: number;
}

/** The board a stored object belongs to, from its folder; null for any other path. */
const OBJECT_OWNER = /^(?:elements|scenes)\/boards\/([A-Za-z0-9_-]{22})\//;

/** True when a report put a Storage hold on anything: the full set, or the part that succeeded before a failure. */
export function hasStorageHolds(report: ReportRecord): boolean {
  return report.held.storageHold || (report.held.storageRefs?.length ?? 0) > 0;
}

/**
 * A report whose Storage hold still stands: a partial hold (some
 * `setHold` calls failed) counts too, and `releaseReportHolds` (a
 * dismiss, or the close-out) stamps `holdsReleasedAt`, so two takedowns
 * sharing objects release in turn instead of protecting each other for
 * good.
 */
function stillHoldsStorage(report: ReportRecord): boolean {
  return report.holdsReleasedAt === undefined && hasStorageHolds(report);
}

/**
 * The objects a report's Storage hold covers: what it recorded at hold
 * time, or, for a record written before `storageRefs` existed, the
 * board's folders (board-wide hold) or its targets' objects as the
 * records stand now.
 */
async function coveredRefs(report: ReportRecord, deps: Pick<ReportDecideDeps, "boards" | "store">): Promise<string[]> {
  if (report.held.storageRefs) return report.held.storageRefs;
  const [elements, scenes] = await Promise.all([
    deps.boards.listElements(report.boardId),
    deps.boards.listScenes(report.boardId, { includeHidden: true }),
  ]);
  if (report.held.boardReview) return listBoardObjectRefs(report.boardId, elements, scenes, deps.store);
  const sceneIds = new Set(report.held.sceneIds.concat(report.scope === "scene" && report.targetId ? [report.targetId] : []));
  return listTargetObjectRefs(
    report.boardId,
    elements.filter((e) => report.held.elementIds.includes(e.id)),
    scenes.filter((s) => sceneIds.has(s.id)),
    deps.store,
  );
}

/**
 * Release the Storage temporary holds one report set (a false alarm, or
 * the docs/20 §7 close-out of a confirmed takedown): exactly its own
 * objects, minus any object another report still holds, on this board
 * (open, or a takedown awaiting its own close-out) or on the board a
 * library copy's bytes belong to. Best-effort per object; returns how
 * many were released, kept and failed.
 */
export async function releaseReportHolds(
  report: ReportRecord,
  deps: Pick<ReportDecideDeps, "boards" | "store" | "reports" | "now">,
): Promise<HoldReleaseResult> {
  const result: HoldReleaseResult = { released: 0, kept: 0, failed: 0 };
  const own = await coveredRefs(report, deps);
  if (own.length === 0) return result;
  const owners = new Set<string>([report.boardId]);
  for (const ref of own) {
    const owner = OBJECT_OWNER.exec(ref)?.[1];
    if (owner) owners.add(owner);
  }
  const protectedRefs = new Set<string>();
  for (const owner of owners) {
    for (const other of await deps.reports.listForBoard(owner)) {
      if (other.id === report.id || !stillHoldsStorage(other)) continue;
      for (const ref of await coveredRefs(other, deps)) protectedRefs.add(ref);
    }
  }
  for (const ref of own) {
    if (protectedRefs.has(ref)) {
      result.kept += 1;
      continue;
    }
    try {
      await deps.store.setHold(ref, false);
      result.released += 1;
    } catch (error) {
      result.failed += 1;
      logServerError("storage hold release failed", error);
    }
  }
  // This report no longer holds anything: what it kept for another
  // report is that report's to release.
  await deps.reports.markHoldsReleased(report.id, deps.now?.() ?? Date.now());
  return result;
}

/**
 * False alarm, or not actionable: put back what this report hid. Holds
 * another open report on the same board still lists stay, and a scene
 * such a report holds on its own is never brought back by a pin's
 * release. The decision is recorded first (claim-before-act, like the
 * jobs): the daily sweep and an operator can both see the same open
 * report, and only the one that claims it acts. Null when the report is
 * missing or already decided.
 */
export async function dismissReport(
  id: string,
  deps: ReportDecideDeps,
  note?: string,
): Promise<DismissOutcome | null> {
  const now = deps.now?.() ?? Date.now();
  const record = await deps.reports.decide(id, { status: "dismissed", decidedAt: now, ...(note ? { note } : {}) });
  if (!record) return null;
  const others = (await deps.reports.listOpenForBoard(record.boardId)).filter((r) => r.id !== id);
  const stillElements = new Set(others.flatMap((r) => r.held.elementIds));
  // A scene another open report holds stays hidden. A scene report
  // lists its scene when it hid it or found it hidden under an
  // `illegal` reason; a queued-only report lists nothing and keeps
  // nothing hidden.
  const stillScenes = new Set(others.flatMap((r) => r.held.sceneIds));
  const stillReview = others.some((r) => r.held.boardReview);
  const released: ReleasedCounts = { elements: 0, scenes: 0, boardReview: false, storage: false };

  for (const elementId of record.held.elementIds) {
    if (stillElements.has(elementId)) continue;
    try {
      if (await deps.boards.releaseElement(elementId, [...stillScenes])) released.elements += 1;
    } catch (error) {
      if (!isGoneBoard(error)) throw error;
    }
  }
  for (const sceneId of record.held.sceneIds) {
    if (stillScenes.has(sceneId)) continue;
    try {
      if (await deps.boards.unhideScene(sceneId)) released.scenes += 1;
    } catch (error) {
      if (!isGoneBoard(error)) throw error;
    }
  }
  if (record.held.boardReview && !stillReview) {
    released.boardReview = await deps.boards.setBoardReview(record.boardId, null);
  }
  if (hasStorageHolds(record)) {
    // Only this report's own objects (a partial hold included), minus
    // what any other holding report (open, or a takedown awaiting its
    // close-out) still needs.
    const holds = await releaseReportHolds(record, deps);
    released.storage = holds.failed === 0;
  }
  return { record, released };
}

export type TakedownOutcome = "element_deleted" | "scene_deleted" | "board_deleted" | "already_gone";

export interface TakedownResult {
  record: ReportRecord;
  outcome: TakedownOutcome;
}

/**
 * Confirmed: remove the reported thing for everyone. Storage holds are
 * left in place (a held object refuses deletion; the sweep counts it as
 * failed and the bytes stay as evidence until `releaseStorageHolds`).
 * The decision is recorded first (claim-before-act), so two actors never
 * both delete or one restores what the other removed. Null when the
 * report is missing or already decided.
 */
export async function takedownReport(
  id: string,
  deps: ReportDecideDeps,
  note?: string,
): Promise<TakedownResult | null> {
  const now = deps.now?.() ?? Date.now();
  const record = await deps.reports.decide(id, { status: "takedown", decidedAt: now, ...(note ? { note } : {}) });
  if (!record) return null;
  // Scenes another open report on the board holds keep their pictures:
  // that report (an `illegal` scene report included) decides them, not
  // this one.
  const others = await deps.reports.listOpenForBoard(record.boardId);
  const keepScenePictures = new Set(others.flatMap((r) => r.held.sceneIds));
  let outcome: TakedownOutcome = "already_gone";
  try {
    if (record.scope === "element" && record.targetId) {
      outcome = await takedownElement(record.boardId, record.targetId, record.held.sceneIds, keepScenePictures, deps);
    } else if (record.scope === "scene" && record.targetId) {
      outcome = await takedownScene(record.targetId, now, deps);
    } else if (record.scope === "board") {
      outcome = await takedownBoard(record.boardId, now, deps);
    }
  } catch (error) {
    if (!isGoneBoard(error)) throw error;
  }
  return { record, outcome };
}

async function takedownElement(
  boardId: string,
  elementId: string,
  heldSceneIds: readonly string[],
  keepScenePictures: ReadonlySet<string>,
  deps: ReportDecideDeps,
): Promise<TakedownOutcome> {
  const element = await deps.boards.getElement(elementId);
  if (!element || element.boardId !== boardId) return "already_gone";
  const result = await deps.boards.deleteElement(elementId);
  if (!result.deleted) return "already_gone";
  // The shared-asset rule of deleteMyElement: bytes go only when no
  // live element elsewhere still points at them. A held object refuses
  // the delete; that is logged and the record is gone all the same.
  const cutoutRef = releaseRef(element.cutoutRef);
  if (!(await elementBytesStillNeeded(cutoutRef, deps.boards, elementId))) {
    for (const ref of [cutoutRef, releaseRef(element.flattenedRef)]) {
      if (!ref.startsWith("elements/")) continue;
      try {
        await deps.store.delete(ref);
      } catch (error) {
        logServerError("takedown left an element object behind", error);
      }
    }
  }
  // The scenes the cascade hid now, and the ones the report's hold hid
  // earlier (the cascade does not list those): their pictures go too.
  for (const sceneId of new Set([...result.hiddenSceneIds, ...heldSceneIds])) {
    if (keepScenePictures.has(sceneId)) continue;
    const scene = await deps.boards.getScene(sceneId);
    if (scene?.boardId === boardId && scene.hidden && scene.elementIds.includes(elementId)) {
      await deleteSceneObjects(scene, deps.store);
    }
  }
  return "element_deleted";
}

async function takedownScene(sceneId: string, now: number, deps: ReportDecideDeps): Promise<TakedownOutcome> {
  const scene = await deps.boards.getScene(sceneId);
  if (!scene || scene.deletedAt !== undefined) return "already_gone";
  const tombstone: Scene = { ...scene, hidden: true, deletedAt: now, deletedBy: "host" };
  await deps.boards.putScene(tombstone);
  await deleteSceneObjects(tombstone, deps.store);
  return "scene_deleted";
}

async function takedownBoard(boardId: string, now: number, deps: ReportDecideDeps): Promise<TakedownOutcome> {
  if (!(await deps.boards.deleteBoard(boardId, now))) return "already_gone";
  await unlinkMyBoards(boardId, deps);
  await sweepDeletedBoardStorage(boardId, deps);
  return "board_deleted";
}

export interface SweepSummary {
  due: number;
  takenDown: number;
  skipped: number;
}

/**
 * The timed takedown (ADR-004 decision 4): open reports whose
 * `deleteAt` passed, `batch` at a time, oldest deadline first. Only a
 * face-flagged likeness report ever carries a deadline; an `illegal`
 * report is skipped here whatever its record says.
 */
export async function sweepDueReports(deps: ReportDecideDeps, now: number, batch: number): Promise<SweepSummary> {
  const summary: SweepSummary = { due: 0, takenDown: 0, skipped: 0 };
  if (batch <= 0) return summary;
  const due = await deps.reports.listOpenDue(now, batch);
  summary.due = due.length;
  for (const record of due) {
    if (record.reason === "illegal") {
      summary.skipped += 1;
      continue;
    }
    const result = await takedownReport(record.id, { ...deps, now: () => now }, "timed takedown (takedownHours)");
    if (result) summary.takenDown += 1;
    else summary.skipped += 1;
  }
  return summary;
}
