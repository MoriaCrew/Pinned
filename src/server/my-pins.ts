import "server-only";
/**
 * My pins library + pin-to-this-board (PIN-85, PIN-57c).
 *
 * Why pin-from-library COPIES the element (issue fallback,
 * taken deliberately): elements are stored in the Firestore
 * subcollection under their ORIGIN board
 * (boards/{slug}/elements/{id}) and `createPin` in both
 * repositories requires the element doc to live under the pin's
 * board — a Pin on board B referencing an element under board A
 * cannot be written without changing that layout, and the
 * delete cascade likewise assumes an element's pins live on its
 * own board. So pinning cross-board creates a copy Element on
 * the target board (new id, `sourceElementId` provenance, the
 * SAME cutout/flattened storage refs) owned by the current
 * participant — who is the same signed-in user, so credit stays
 * with them — plus a normal pinned Pin (`pinnedBy` = current
 * participant). From then on the copy composes in scenes,
 * remixes and the delete cascade exactly like a native pin;
 * `deleteMyElement` guards the shared storage objects so
 * deleting either record leaves the other side's assets alive.
 *
 * Ownership: an element belongs to a user when its owner
 * Participant (on the element's own board) carries
 * `userId === uid` — the same live check My boards uses,
 * re-verified here per element. The user board index is only
 * the enumeration starting point. Every ownership or existence
 * miss is the uniform 404 / null: no source-board slug ever
 * appears in a response or URL (title label only).
 */
import { createHash, randomUUID } from "node:crypto";
import type { Element, Participant, Pin } from "../domain/board";
import type { BoardRepository } from "../domain/board-repository";
import {
  clampLibraryLimit,
  sortMyPins,
  type MyPinCard,
} from "../domain/my-pins";
import type { UserProfile } from "../domain/user";
import type { UserRepository } from "../domain/user-repository";
import type { Policy } from "../policy/policy";
import { BoardApiError } from "./board-session";
import type { DerivativeStore } from "./derivative-store";

export interface MyPinsDeps {
  boards: BoardRepository;
  users: UserRepository;
  policy: Policy;
  now?: () => number;
  newId?: () => string;
}

export interface MyPinsImageDeps {
  boards: BoardRepository;
  store: DerivativeStore;
}

/** Owner-checked thumbnail URL: element id only, never a slug. */
export function myPinImageUrl(elementId: string, kind: "cutout" | "flattened"): string {
  return `/api/me/elements/${encodeURIComponent(elementId)}/image?kind=${kind}`;
}

export interface MyPinsPage {
  elements: MyPinCard[];
  /** Owned elements across claimed boards before the limit. */
  total: number;
  limit: number;
}

/**
 * The signed-in user's pinned elements across every board they
 * hold a live claim on, newest first, capped at the Policy page
 * size. Candidates (still in review, left out, or cleared) are
 * not listed (PIN-125).
 * Index entries whose board is gone or whose participant no
 * longer carries this user's claim are skipped (My boards
 * parity), and each element's owner must be that claimed
 * participant.
 */
export async function listMyElements(
  user: UserProfile,
  deps: MyPinsDeps,
  requestedLimit?: number | null,
): Promise<MyPinsPage> {
  const limit = clampLibraryLimit(requestedLimit, deps.policy.libraryPageSize);
  const entries = await deps.users.listUserBoards(user.uid);
  const cards: MyPinCard[] = [];
  for (const entry of entries) {
    const board = await deps.boards.getBoard(entry.boardId);
    if (!board) continue;
    const participant = await deps.boards.getParticipant(
      entry.boardId,
      entry.participantId,
    );
    if (!participant || participant.userId !== user.uid) continue;
    const elements = await deps.boards.listElementsByOwner(
      entry.boardId,
      participant.id,
    );
    if (elements.length === 0) continue;
    // PIN-125: only things that are pinned. A candidate the user
    // left out or cleared loses its pin but keeps its element, and
    // must not come back through the library. One pin read per
    // board, not one per element.
    const pinned = new Set(
      (await deps.boards.listPins(entry.boardId, "pinned")).map((pin) => pin.elementId),
    );
    for (const element of elements) {
      if (!pinned.has(element.id)) continue;
      cards.push({
        elementId: element.id,
        familyId: element.sourceElementId ?? element.id,
        label: element.label,
        description: element.description,
        faceFlag: element.faceFlag,
        sourceBoardTitle: board.title,
        imageUrl: myPinImageUrl(element.id, "cutout"),
        createdAt: element.createdAt,
      });
    }
  }
  const sorted = sortMyPins(cards);
  return { elements: sorted.slice(0, limit), total: sorted.length, limit };
}

/** True when `element`'s owner participant is claimed by `user`. */
async function ownsElement(
  user: UserProfile,
  element: Element,
  boards: BoardRepository,
): Promise<boolean> {
  const owner = await boards.getParticipant(element.boardId, element.ownerId);
  return owner !== null && owner.userId === user.uid;
}

/**
 * Owner-checked element image for the library. Unlike the
 * board-link route (slug = capability), this path authorizes by
 * signed-in ownership alone, so a thumbnail works without ever
 * exposing the source board's slug. Every miss — bad kind,
 * missing element, another user's element, a non-elements/ ref,
 * a missing stored object — returns null for the uniform 404.
 */
export async function resolveOwnedElementImage(
  user: UserProfile | null,
  elementId: string,
  kind: string | null,
  deps: MyPinsImageDeps,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!user) return null;
  if (kind !== "cutout" && kind !== "flattened") return null;
  const element = await deps.boards.getElement(elementId);
  if (!element) return null;
  if (!(await ownsElement(user, element, deps.boards))) return null;
  const ref = kind === "cutout" ? element.cutoutRef : element.flattenedRef;
  if (!ref.startsWith("elements/")) return null;
  const bytes = await deps.store.get(ref);
  if (!bytes) return null;
  return {
    bytes,
    contentType: kind === "cutout" ? "image/png" : "image/jpeg",
  };
}

/**
 * Deterministic library-copy id per (target board, source
 * element): a double-submit or retry derives the SAME id, so a
 * racing second create collides in the repository instead of
 * minting a duplicate copy. Hashed, so neither the source id
 * nor a board slug is readable from it.
 */
export function libraryCopyId(slug: string, sourceElementId: string): string {
  const digest = createHash("sha256")
    .update(`library-copy:${slug}:${sourceElementId}`)
    .digest("hex");
  return `lib-${digest.slice(0, 32)}`;
}

export function parsePinFromLibraryInput(value: unknown): { elementId: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoardApiError("Pick a pin from your library.");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.elementId !== "string" || !body.elementId) {
    throw new BoardApiError("Pick a pin from your library.");
  }
  return { elementId: body.elementId };
}

export interface PinFromLibraryResult {
  /** True when the pin was already on this board (friendly no-op). */
  alreadyPinned: boolean;
  pin: Pin;
  /** The element now on the target board (copy or native). */
  elementId: string;
}

/**
 * Pin a library element onto `slug` as the current participant.
 * No participant, a missing board/element, or an element owned
 * by somebody else are the uniform 404. The one-pin-per-board
 * rule holds: pinning the same library element twice returns
 * `alreadyPinned` with the existing pin instead of an error.
 * Same-board elements pin natively (no copy); cross-board ones
 * copy first (see the module note).
 */
export async function pinFromLibrary(
  slug: string,
  participant: Participant | null,
  user: UserProfile,
  sourceElementId: string,
  deps: MyPinsDeps,
): Promise<PinFromLibraryResult> {
  if (!participant || participant.boardId !== slug) {
    throw new BoardApiError("Element not found.", 404);
  }
  const board = await deps.boards.getBoard(slug);
  if (!board) throw new BoardApiError("Element not found.", 404);
  const source = await deps.boards.getElement(sourceElementId);
  if (!source || !(await ownsElement(user, source, deps.boards))) {
    throw new BoardApiError("Element not found.", 404);
  }

  const now = deps.now?.() ?? Date.now();
  const newId = deps.newId ?? randomUUID;

  // Family root: copies always point sourceElementId at the
  // ORIGINAL element (never at an intermediate copy), so the
  // root is one hop away and stays meaningful even after the
  // original is deleted. One board holds at most one family
  // member: the root itself or a single copy of it.
  const rootId = source.sourceElementId ?? source.id;
  const familyRoot = (element: Element) => element.sourceElementId ?? element.id;

  // The element on THIS board representing the source family:
  // the source itself when native here, else the family member
  // already on this board (root or earlier copy), else a copy.
  let target: Element;
  if (source.boardId === slug) {
    target = source;
  } else {
    const existing = (await deps.boards.listElements(slug)).find(
      (element) => familyRoot(element) === rootId,
    );
    if (existing) {
      target = existing;
    } else {
      target = {
        id: libraryCopyId(slug, rootId),
        boardId: slug,
        ownerId: participant.id,
        label: source.label,
        description: source.description,
        maskBox: source.maskBox,
        cutoutRef: source.cutoutRef,
        flattenedRef: source.flattenedRef,
        sourcePhotoId: source.sourcePhotoId,
        faceFlag: source.faceFlag,
        sourceElementId: rootId,
        createdAt: now,
      };
      try {
        await deps.boards.createElement(target);
      } catch (error) {
        // Deterministic id: a racing pin created the copy first.
        if (!(error instanceof RangeError)) throw error;
        const winner = await deps.boards.getElement(target.id);
        if (
          !winner ||
          winner.boardId !== slug ||
          winner.sourceElementId !== rootId
        ) {
          throw error;
        }
        target = winner;
      }
    }
  }

  const existingPin = (await deps.boards.listPins(slug)).find(
    (pin) => pin.elementId === target.id,
  );
  if (existingPin) {
    // A candidate pin (e.g. the source job's) becomes pinned;
    // an already-pinned one is the friendly no-op.
    if (existingPin.status === "pinned") {
      return { alreadyPinned: true, pin: existingPin, elementId: target.id };
    }
    const promoted = await deps.boards.setPinStatus(existingPin.id, "pinned", now);
    return {
      alreadyPinned: false,
      pin: promoted ?? existingPin,
      elementId: target.id,
    };
  }

  const pin: Pin = {
    id: newId(),
    boardId: slug,
    elementId: target.id,
    pinnedBy: participant.id,
    status: "pinned",
    createdAt: now,
  };
  try {
    await deps.boards.createPin(pin);
  } catch (error) {
    // A concurrent double-pin: the repository's one-pin rule
    // fired, which for the caller is the same already-pinned end
    // state if the winning pin is pinned.
    if (error instanceof RangeError) {
      const winner = (await deps.boards.listPins(slug)).find(
        (candidate) => candidate.elementId === target.id,
      );
      if (winner?.status === "pinned") {
        return { alreadyPinned: true, pin: winner, elementId: target.id };
      }
    }
    throw error;
  }
  return { alreadyPinned: false, pin, elementId: target.id };
}
