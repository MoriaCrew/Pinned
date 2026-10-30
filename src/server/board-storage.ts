import "server-only";
/**
 * A deleted board's stored objects (PIN-169, docs/13-auth.md "Board
 * delete"). A board's objects live under exactly three folders, built
 * here from a valid slug with the trailing slash (slugs are a fixed
 * length, so no board's folder is a prefix of another's): working
 * copies (`tmp/`), cut-outs (`elements/`) and scene pictures
 * (`scenes/`). The sweep runs only on a board that is not live,
 * deletes only inside those folders, and keeps one thing: an element
 * folder whose cut-out a library copy (PIN-85) on a LIVE board still
 * points at. Elements on deleted boards never count as needing bytes,
 * here or in deleteMyElement, so the last live copy going (by its own
 * delete or its board's) frees them.
 *
 * Best-effort and idempotent: never throws (the board is already gone
 * for everyone), logs by error name only (never a slug or ref), and a
 * later run removes what an earlier one missed or a late job wrote.
 */
import { isLiveBoard, type BoardRepository } from "../domain/board-repository";
import { isValidSlug } from "../domain/tokens";
import type { DerivativeStore } from "./derivative-store";

/** An element's cut-out file in its folder (decompose-job builds the ref). */
export const ELEMENT_CUTOUT_FILE = "cutout.png";

const ELEMENTS_ROOT = "elements/boards/";

/** The board's three storage folders, each ending in "/"; null unless the slug is valid. */
export function boardStoragePrefixes(slug: string): [tmp: string, elements: string, scenes: string] | null {
  if (!isValidSlug(slug)) return null;
  return [`tmp/boards/${slug}/`, `${ELEMENTS_ROOT}${slug}/`, `scenes/boards/${slug}/`];
}

type NeedsBoards = Pick<BoardRepository, "getBoard" | "listElementsByCutoutRef">;

export interface BoardStorageDeps {
  boards: NeedsBoards & Pick<BoardRepository, "listElements">;
  store: DerivativeStore;
}

/**
 * The shared-asset rule (PIN-85, PIN-169): element bytes are still
 * needed while an element other than `exceptElementId` points at
 * `cutoutRef` from a live board. Records on a deleted board never count.
 */
export async function elementBytesStillNeeded(
  cutoutRef: string,
  boards: NeedsBoards,
  exceptElementId?: string,
): Promise<boolean> {
  for (const other of await boards.listElementsByCutoutRef(cutoutRef)) {
    if (other.id === exceptElementId) continue;
    if (await isLiveBoard(boards, other.boardId)) return true;
  }
  return false;
}

/** `elements/boards/{slug}/{elementId}/` when `ref` is a file directly inside one, else null. */
function elementFolder(ref: string): string | null {
  const [root, boards, slug, id, file, ...rest] = ref.split("/");
  if (`${root}/${boards}/` !== ELEMENTS_ROOT || !isValidSlug(slug ?? "")) return null;
  return id && file && rest.length === 0 ? `${ELEMENTS_ROOT}${slug}/${id}/` : null;
}

function logFailure(error: unknown): void {
  console.error("Board storage clean-up left objects behind.", {
    error: error instanceof Error ? error.name : "unknown",
  });
}

export interface BoardSweepResult {
  deleted: number;
  kept: number;
  failed: number;
}

/**
 * Remove a deleted board's stored objects. A no-op for an invalid
 * slug and for a live board, so the board delete and any late writer
 * (a job that outlived its board) can call it again safely.
 */
export async function sweepDeletedBoardStorage(
  slug: string,
  deps: BoardStorageDeps,
): Promise<BoardSweepResult> {
  const result: BoardSweepResult = { deleted: 0, kept: 0, failed: 0 };
  const prefixes = boardStoragePrefixes(slug);
  if (!prefixes) return result;
  const remove = async (ref: string) => {
    try {
      await deps.store.delete(ref);
      result.deleted += 1;
    } catch (error) {
      result.failed += 1;
      logFailure(error);
    }
  };
  try {
    if (await isLiveBoard(deps.boards, slug)) return result;
    // Library copies here keep their source's refs in another board's
    // element folder. Once nothing live needs those bytes, this board
    // held the last live copy: free them as deleteMyElement would.
    for (const element of await deps.boards.listElements(slug)) {
      const folder = elementFolder(element.cutoutRef);
      if (!folder || folder.startsWith(prefixes[1])) continue;
      if (elementFolder(element.flattenedRef) !== folder) continue;
      if (await elementBytesStillNeeded(element.cutoutRef, deps.boards)) continue;
      for (const ref of [element.cutoutRef, element.flattenedRef]) await remove(ref);
    }
    // The three folders. An element folder is kept whole while a copy
    // on a live board points at its cut-out, decided from storage (not
    // from this board's records: its own element may be gone already).
    const needed = new Map<string, Promise<boolean>>();
    for (const prefix of prefixes) {
      for (const ref of await deps.store.listPrefix(prefix)) {
        if (!ref.startsWith(prefix)) continue; // never outside the three folders
        const folder = prefix === prefixes[1] ? elementFolder(ref) : null;
        if (folder) {
          if (!needed.has(folder)) {
            needed.set(folder, elementBytesStillNeeded(`${folder}${ELEMENT_CUTOUT_FILE}`, deps.boards));
          }
          if (await needed.get(folder)) {
            result.kept += 1;
            continue;
          }
        }
        await remove(ref);
      }
    }
  } catch (error) {
    result.failed += 1;
    logFailure(error);
  }
  return result;
}
