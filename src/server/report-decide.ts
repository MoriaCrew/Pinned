import "server-only";
/**
 * The operator's side of Report & hold (PIN-272, ADR-004 decision 6,
 * docs/20): dismiss restores exactly what a report held, unless another
 * open report on the same board still needs it; takedown removes the
 * reported thing the way the product deletes (element cascade, scene
 * tombstone, board tombstone + unlink + storage sweep); the backstop
 * takes down the reports whose deadline passed, never an `illegal`
 * one. Storage temporary holds are released only by `releaseStorageHolds`
 * (the close-out of docs/20 §8), never by a takedown: a held object
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

/** Every stored object a board's records point at (held refs unprefixed), tombstoned boards included. */
async function boardObjectRefs(boardId: string, boards: BoardRepository): Promise<string[]> {
  const refs = new Set<string>();
  for (const element of await boards.listElements(boardId)) {
    refs.add(releaseRef(element.cutoutRef));
    refs.add(releaseRef(element.flattenedRef));
  }
  for (const scene of await boards.listScenes(boardId, { includeHidden: true })) {
    if (scene.imageRef) refs.add(scene.imageRef);
  }
  return [...refs];
}

/**
 * Release the Storage temporary holds on everything a board's records
 * point at (docs/20 §8 close-out, or a false alarm). Best-effort per
 * object; returns how many were released and how many failed.
 */
export async function releaseStorageHolds(
  boardId: string,
  deps: Pick<ReportDecideDeps, "boards" | "store">,
): Promise<{ released: number; failed: number }> {
  const result = { released: 0, failed: 0 };
  for (const ref of await boardObjectRefs(boardId, deps.boards)) {
    try {
      await deps.store.setHold(ref, false);
      result.released += 1;
    } catch (error) {
      result.failed += 1;
      logServerError("storage hold release failed", error);
    }
  }
  return result;
}

/**
 * False alarm, or not actionable: put back what this report hid. Holds
 * another open report on the same board still lists stay. Null when the
 * report is missing or already decided.
 */
export async function dismissReport(
  id: string,
  deps: ReportDecideDeps,
  note?: string,
): Promise<DismissOutcome | null> {
  const record = await deps.reports.get(id);
  if (!record || record.status !== "open") return null;
  const now = deps.now?.() ?? Date.now();
  const others = (await deps.reports.listOpenForBoard(record.boardId)).filter((r) => r.id !== id);
  const stillElements = new Set(others.flatMap((r) => r.held.elementIds));
  const stillScenes = new Set(others.flatMap((r) => r.held.sceneIds));
  const stillReview = others.some((r) => r.held.boardReview);
  const stillStorage = others.some((r) => r.held.storageHold);
  const released: ReleasedCounts = { elements: 0, scenes: 0, boardReview: false, storage: false };

  for (const elementId of record.held.elementIds) {
    if (stillElements.has(elementId)) continue;
    try {
      if (await deps.boards.releaseElement(elementId)) released.elements += 1;
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
  if (record.held.storageHold && !stillStorage) {
    const holds = await releaseStorageHolds(record.boardId, deps);
    released.storage = holds.failed === 0;
  }
  const decided = await deps.reports.decide(id, { status: "dismissed", decidedAt: now, ...(note ? { note } : {}) });
  return decided ? { record: decided, released } : null;
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
 * Null when the report is missing or already decided.
 */
export async function takedownReport(
  id: string,
  deps: ReportDecideDeps,
  note?: string,
): Promise<TakedownResult | null> {
  const record = await deps.reports.get(id);
  if (!record || record.status !== "open") return null;
  const now = deps.now?.() ?? Date.now();
  let outcome: TakedownOutcome = "already_gone";
  try {
    if (record.scope === "element" && record.targetId) {
      outcome = await takedownElement(record.boardId, record.targetId, record.held.sceneIds, deps);
    } else if (record.scope === "scene" && record.targetId) {
      outcome = await takedownScene(record.targetId, now, deps);
    } else if (record.scope === "board") {
      outcome = await takedownBoard(record.boardId, now, deps);
    }
  } catch (error) {
    if (!isGoneBoard(error)) throw error;
  }
  const decided = await deps.reports.decide(id, { status: "takedown", decidedAt: now, ...(note ? { note } : {}) });
  return decided ? { record: decided, outcome } : null;
}

async function takedownElement(
  boardId: string,
  elementId: string,
  heldSceneIds: readonly string[],
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
