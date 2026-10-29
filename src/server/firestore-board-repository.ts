import "server-only";
/**
 * Firestore BoardRepository (PIN-63, docs/11 §5.4). Server-only:
 * client Firestore access stays deny-all in firestore.rules.
 * Passes the shared suite in board-repository.contract.ts against
 * a fake Firestore, same pattern as firestore-repository.test.ts.
 *
 * Layout (coexists with games/; nothing here reads or writes it):
 * - boards/{slug}
 * - boards/{slug}/participants|elements|pins|scenes|events/{id}
 * - boards/{slug}/jobs/{jobId} is RESERVED for DecomposeJob /
 *   SceneJob docs (§5.3); the BoardRepository port has no job
 *   methods yet, so nothing writes it in this slice.
 *
 * Element/pin/scene ids are globally unique in the contract while
 * storage is per-board, so board-agnostic lookups (getElement,
 * getPin, getScene, listPinsForElement, the delete cascade's
 * scene scan) use collection-group queries. Those need the
 * COLLECTION_GROUP indexes in firestore.indexes.json; an operator
 * must `firebase deploy --only firestore:indexes` before hosted
 * board traffic uses this backend. All other filtering/sorting
 * happens in code over the small per-board subcollections.
 *
 * Each subcollection doc carries an internal `_seq` (append order
 * within that subcollection) so list ordering can be
 * createdAt-ascending with append-order ties, exactly like the
 * in-memory implementation. `_seq` is stripped on every read.
 * Writes strip undefined via JSON round-trip (Firestore rejects
 * undefined), which also deep-clones caller input. Mutations that
 * touch counters, docs and emitted events run in one transaction
 * with all reads before writes.
 */
import {
  Firestore,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
  type QuerySnapshot,
  type Transaction,
} from "@google-cloud/firestore";
import type {
  Board,
  BoardCounters,
  BoardEvent,
  Element,
  Participant,
  Pin,
  PinStatus,
  Scene,
} from "../domain/board";
import type {
  BoardRepository,
  DeleteElementResult,
} from "../domain/board-repository";

const BOARDS = "boards";
const PARTICIPANTS = "participants";
const ELEMENTS = "elements";
const PINS = "pins";
const SCENES = "scenes";
const EVENTS = "events";

function toFirestoreData<T extends object>(value: T): DocumentData {
  return JSON.parse(JSON.stringify(value)) as DocumentData;
}

function toStored<T extends object>(value: T, seq: number): DocumentData {
  return { ...toFirestoreData(value), _seq: seq };
}

interface StoredRow<T> {
  ref: DocumentReference;
  value: T;
  seq: number;
}

function rowFrom<T>(ref: DocumentReference, data: DocumentData): StoredRow<T> {
  const { _seq, ...rest } = structuredClone(data);
  return {
    ref,
    value: rest as unknown as T,
    seq: typeof _seq === "number" ? _seq : 0,
  };
}

function rowsFrom<T>(snapshot: QuerySnapshot): StoredRow<T>[] {
  return snapshot.docs.map((doc) => rowFrom<T>(doc.ref, doc.data()));
}

function nextSeq<T>(rows: readonly StoredRow<T>[]): number {
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
}

/** createdAt-ascending, ties keep append order (_seq). */
function sortedValues<T extends { createdAt: number }>(
  rows: readonly StoredRow<T>[],
): T[] {
  return [...rows]
    .sort((a, b) => a.value.createdAt - b.value.createdAt || a.seq - b.seq)
    .map((row) => row.value);
}

function fromSnapshot<T>(snapshot: DocumentSnapshot): T | null {
  if (!snapshot.exists) return null;
  return rowFrom<T>(snapshot.ref, snapshot.data() as DocumentData).value;
}

function isAlreadyExists(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === 6 ||
    candidate.code === "already-exists" ||
    (typeof candidate.message === "string" && /already exists/i.test(candidate.message))
  );
}

type CounterDelta = Partial<Record<keyof BoardCounters, number>>;

function withCounters(board: Board, delta: CounterDelta): Board {
  const counters = { ...board.counters };
  for (const key of Object.keys(delta) as (keyof BoardCounters)[]) {
    counters[key] += delta[key] ?? 0;
  }
  return { ...board, counters };
}

function mergeDelta(into: CounterDelta, delta: CounterDelta): void {
  for (const key of Object.keys(delta) as (keyof BoardCounters)[]) {
    into[key] = (into[key] ?? 0) + (delta[key] ?? 0);
  }
}

export class FirestoreBoardRepository implements BoardRepository {
  constructor(private readonly db: Firestore) {}

  private boardRef(slug: string): DocumentReference {
    return this.db.collection(BOARDS).doc(slug);
  }

  private col(slug: string, name: string): CollectionReference {
    return this.boardRef(slug).collection(name);
  }

  /** One global id lookup; ids are unique, first hit wins. */
  private async findOneById<T>(name: string, id: string): Promise<StoredRow<T> | null> {
    const snap = await this.db.collectionGroup(name).where("id", "==", id).get();
    const rows = rowsFrom<T>(snap);
    return rows[0] ?? null;
  }

  private async txFindOneById<T>(
    tx: Transaction,
    name: string,
    id: string,
  ): Promise<StoredRow<T> | null> {
    const query: Query = this.db.collectionGroup(name).where("id", "==", id);
    const rows = rowsFrom<T>(await tx.get(query));
    return rows[0] ?? null;
  }

  private async requireBoardTx(tx: Transaction, slug: string): Promise<Board> {
    const board = fromSnapshot<Board>(await tx.get(this.boardRef(slug)));
    if (!board) throw new RangeError(`Board ${slug} not found`);
    return board;
  }

  async createBoard(board: Board): Promise<void> {
    try {
      await this.boardRef(board.slug).create(toFirestoreData(board));
    } catch (error) {
      if (isAlreadyExists(error)) throw new RangeError(`Board ${board.slug} already exists`);
      throw error;
    }
  }

  async getBoard(slug: string): Promise<Board | null> {
    return fromSnapshot<Board>(await this.boardRef(slug).get());
  }

  async putParticipant(participant: Participant): Promise<void> {
    const ref = this.col(participant.boardId, PARTICIPANTS).doc(participant.id);
    await this.db.runTransaction(async (tx) => {
      const board = await this.requireBoardTx(tx, participant.boardId);
      const existing = await tx.get(ref);
      const rows = existing.exists
        ? null
        : rowsFrom<Participant>(await tx.get(this.col(participant.boardId, PARTICIPANTS)));
      const seq = existing.exists
        ? rowFrom<Participant>(ref, existing.data() as DocumentData).seq
        : nextSeq(rows as StoredRow<Participant>[]);
      const events = existing.exists
        ? null
        : rowsFrom<BoardEvent>(await tx.get(this.col(participant.boardId, EVENTS)));
      tx.set(ref, toStored(participant, seq));
      if (!existing.exists) {
        tx.set(
          this.boardRef(participant.boardId),
          toFirestoreData(withCounters(board, { participantCount: 1 })),
        );
        const eventRef = this.col(participant.boardId, EVENTS).doc();
        const event: BoardEvent = {
          id: eventRef.id,
          boardId: participant.boardId,
          type: "participant_joined",
          actorId: participant.id,
          createdAt: participant.createdAt,
        };
        tx.set(eventRef, toStored(event, nextSeq(events as StoredRow<BoardEvent>[])));
      }
    });
  }

  async getParticipant(boardId: string, participantId: string): Promise<Participant | null> {
    return fromSnapshot<Participant>(
      await this.col(boardId, PARTICIPANTS).doc(participantId).get(),
    );
  }

  async listParticipants(boardId: string): Promise<Participant[]> {
    return sortedValues(rowsFrom<Participant>(await this.col(boardId, PARTICIPANTS).get()));
  }

  async createElement(element: Element): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const board = await this.requireBoardTx(tx, element.boardId);
      if ((await this.txFindOneById<Element>(tx, ELEMENTS, element.id)) !== null) {
        throw new RangeError(`Element ${element.id} already exists`);
      }
      const elements = rowsFrom<Element>(await tx.get(this.col(element.boardId, ELEMENTS)));
      const events = rowsFrom<BoardEvent>(await tx.get(this.col(element.boardId, EVENTS)));
      const eventRef = this.col(element.boardId, EVENTS).doc();
      const event: BoardEvent = {
        id: eventRef.id,
        boardId: element.boardId,
        type: "element_added",
        actorId: element.ownerId,
        elementId: element.id,
        createdAt: element.createdAt,
      };
      tx.set(this.col(element.boardId, ELEMENTS).doc(element.id), toStored(element, nextSeq(elements)));
      tx.set(eventRef, toStored(event, nextSeq(events)));
      tx.set(
        this.boardRef(element.boardId),
        toFirestoreData(withCounters(board, { elementCount: 1 })),
      );
    });
  }

  async getElement(elementId: string): Promise<Element | null> {
    return (await this.findOneById<Element>(ELEMENTS, elementId))?.value ?? null;
  }

  async listElements(boardId: string): Promise<Element[]> {
    return sortedValues(rowsFrom<Element>(await this.col(boardId, ELEMENTS).get()));
  }

  async listElementsByOwner(boardId: string, ownerId: string): Promise<Element[]> {
    const rows = rowsFrom<Element>(await this.col(boardId, ELEMENTS).get());
    return sortedValues(rows.filter((row) => row.value.ownerId === ownerId));
  }

  async listElementsBySource(sourceElementId: string): Promise<Element[]> {
    const snap = await this.db
      .collectionGroup(ELEMENTS)
      .where("sourceElementId", "==", sourceElementId)
      .get();
    return sortedValues(rowsFrom<Element>(snap));
  }

  async deleteElement(elementId: string): Promise<DeleteElementResult> {
    const found = await this.findOneById<Element>(ELEMENTS, elementId);
    if (!found) return { deleted: false, removedPinIds: [], hiddenSceneIds: [] };
    const boardId = found.value.boardId;
    return this.db.runTransaction(async (tx) => {
      const elementSnap = await tx.get(found.ref);
      if (!elementSnap.exists) return { deleted: false, removedPinIds: [], hiddenSceneIds: [] };
      const board = await this.requireBoardTx(tx, boardId);
      // Pins for an element live on its board (createPin enforces
      // same-board), so the board subcollection is the full set.
      const pinRows = rowsFrom<Pin>(await tx.get(this.col(boardId, PINS))).filter(
        (row) => row.value.elementId === elementId,
      );
      // Scenes are not validated against elements at write time, so
      // match the in-memory cascade with a collection-group scan.
      const sceneQuery: Query = this.db
        .collectionGroup(SCENES)
        .where("elementIds", "array-contains", elementId);
      const sceneRows = rowsFrom<Scene>(await tx.get(sceneQuery)).filter(
        (row) => !row.value.hidden,
      );
      const otherBoards = new Map<string, Board>();
      for (const sceneBoardId of new Set(sceneRows.map((row) => row.value.boardId))) {
        if (sceneBoardId !== boardId) otherBoards.set(sceneBoardId, await this.requireBoardTx(tx, sceneBoardId));
      }
      const orderedPins = [...pinRows].sort(
        (a, b) => a.value.createdAt - b.value.createdAt || a.seq - b.seq,
      );
      const orderedScenes = [...sceneRows].sort(
        (a, b) => a.value.createdAt - b.value.createdAt || a.seq - b.seq,
      );
      const deltas = new Map<string, CounterDelta>();
      const addDelta = (slug: string, delta: CounterDelta) => {
        const existing = deltas.get(slug) ?? {};
        mergeDelta(existing, delta);
        deltas.set(slug, existing);
      };
      tx.delete(found.ref);
      addDelta(boardId, { elementCount: -1 });
      for (const row of orderedPins) {
        tx.delete(row.ref);
        if (row.value.status === "pinned") addDelta(row.value.boardId, { pinCount: -1 });
      }
      for (const row of orderedScenes) {
        tx.set(row.ref, toStored({ ...row.value, hidden: true }, row.seq));
        addDelta(row.value.boardId, { sceneCount: -1 });
      }
      for (const [slug, delta] of deltas) {
        const base = slug === boardId ? board : (otherBoards.get(slug) as Board);
        tx.set(this.boardRef(slug), toFirestoreData(withCounters(base, delta)));
      }
      return {
        deleted: true,
        removedPinIds: orderedPins.map((row) => row.value.id),
        hiddenSceneIds: orderedScenes.map((row) => row.value.id),
      };
    });
  }

  async createPin(pin: Pin): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const board = await this.requireBoardTx(tx, pin.boardId);
      if ((await this.txFindOneById<Pin>(tx, PINS, pin.id)) !== null) {
        throw new RangeError(`Pin ${pin.id} already exists`);
      }
      const elementSnap = await tx.get(this.col(pin.boardId, ELEMENTS).doc(pin.elementId));
      if (!elementSnap.exists) {
        throw new RangeError(`Element ${pin.elementId} not found on board ${pin.boardId}`);
      }
      const pins = rowsFrom<Pin>(await tx.get(this.col(pin.boardId, PINS)));
      if (pins.some((row) => row.value.elementId === pin.elementId)) {
        throw new RangeError(`Element ${pin.elementId} is already pinned on board ${pin.boardId}`);
      }
      const events =
        pin.status === "pinned"
          ? rowsFrom<BoardEvent>(await tx.get(this.col(pin.boardId, EVENTS)))
          : null;
      tx.set(this.col(pin.boardId, PINS).doc(pin.id), toStored(pin, nextSeq(pins)));
      if (pin.status === "pinned") {
        const eventRef = this.col(pin.boardId, EVENTS).doc();
        const event: BoardEvent = {
          id: eventRef.id,
          boardId: pin.boardId,
          type: "pin_added",
          actorId: pin.pinnedBy,
          elementId: pin.elementId,
          pinId: pin.id,
          createdAt: pin.createdAt,
        };
        tx.set(eventRef, toStored(event, nextSeq(events as StoredRow<BoardEvent>[])));
        tx.set(this.boardRef(pin.boardId), toFirestoreData(withCounters(board, { pinCount: 1 })));
      }
    });
  }

  async getPin(pinId: string): Promise<Pin | null> {
    return (await this.findOneById<Pin>(PINS, pinId))?.value ?? null;
  }

  async listPins(boardId: string, status?: PinStatus): Promise<Pin[]> {
    const rows = rowsFrom<Pin>(await this.col(boardId, PINS).get());
    return sortedValues(
      status === undefined ? rows : rows.filter((row) => row.value.status === status),
    );
  }

  async listPinsForElement(elementId: string): Promise<Pin[]> {
    const snap = await this.db.collectionGroup(PINS).where("elementId", "==", elementId).get();
    return sortedValues(rowsFrom<Pin>(snap));
  }

  async setPinStatus(pinId: string, status: PinStatus, now: number): Promise<Pin | null> {
    const found = await this.findOneById<Pin>(PINS, pinId);
    if (!found) return null;
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(found.ref);
      if (!snap.exists) return null;
      const row = rowFrom<Pin>(found.ref, snap.data() as DocumentData);
      if (row.value.status === status) return row.value;
      const board = await this.requireBoardTx(tx, row.value.boardId);
      const events =
        status === "pinned"
          ? rowsFrom<BoardEvent>(await tx.get(this.col(row.value.boardId, EVENTS)))
          : null;
      const updated: Pin = { ...row.value, status };
      tx.set(found.ref, toStored(updated, row.seq));
      if (status === "pinned") {
        const eventRef = this.col(row.value.boardId, EVENTS).doc();
        tx.set(eventRef, toStored({
          id: eventRef.id,
          boardId: row.value.boardId,
          type: "pin_added",
          actorId: row.value.pinnedBy,
          elementId: row.value.elementId,
          pinId: row.value.id,
          createdAt: now,
        } satisfies BoardEvent, nextSeq(events as StoredRow<BoardEvent>[])));
        tx.set(this.boardRef(row.value.boardId), toFirestoreData(withCounters(board, { pinCount: 1 })));
      } else {
        tx.set(this.boardRef(row.value.boardId), toFirestoreData(withCounters(board, { pinCount: -1 })));
      }
      return structuredClone(updated);
    });
  }

  async deletePin(pinId: string): Promise<boolean> {
    const found = await this.findOneById<Pin>(PINS, pinId);
    if (!found) return false;
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(found.ref);
      if (!snap.exists) return false;
      const row = rowFrom<Pin>(found.ref, snap.data() as DocumentData);
      const board =
        row.value.status === "pinned" ? await this.requireBoardTx(tx, row.value.boardId) : null;
      tx.delete(found.ref);
      if (board) {
        tx.set(this.boardRef(row.value.boardId), toFirestoreData(withCounters(board, { pinCount: -1 })));
      }
      return true;
    });
  }

  async putScene(scene: Scene): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const board = await this.requireBoardTx(tx, scene.boardId);
      const before = await this.txFindOneById<Scene>(tx, SCENES, scene.id);
      if (before && before.value.boardId !== scene.boardId) {
        throw new RangeError(`Scene ${scene.id} belongs to board ${before.value.boardId}`);
      }
      const scenes = before
        ? null
        : rowsFrom<Scene>(await tx.get(this.col(scene.boardId, SCENES)));
      const seq = before ? before.seq : nextSeq(scenes as StoredRow<Scene>[]);
      const wasVisible = before ? !before.value.hidden : false;
      const delta = Number(!scene.hidden) - Number(wasVisible);
      tx.set(this.col(scene.boardId, SCENES).doc(scene.id), toStored(scene, seq));
      if (delta !== 0) {
        tx.set(this.boardRef(scene.boardId), toFirestoreData(withCounters(board, { sceneCount: delta })));
      }
    });
  }

  async getScene(sceneId: string): Promise<Scene | null> {
    return (await this.findOneById<Scene>(SCENES, sceneId))?.value ?? null;
  }

  async listScenes(boardId: string, opts?: { includeHidden?: boolean }): Promise<Scene[]> {
    const rows = rowsFrom<Scene>(await this.col(boardId, SCENES).get());
    return sortedValues(
      opts?.includeHidden ? rows : rows.filter((row) => !row.value.hidden),
    );
  }

  async appendEvent(event: BoardEvent): Promise<void> {
    const ref = this.col(event.boardId, EVENTS).doc(event.id);
    await this.db.runTransaction(async (tx) => {
      await this.requireBoardTx(tx, event.boardId);
      const existing = await tx.get(ref);
      if (existing.exists) {
        throw new RangeError(`Event ${event.id} already exists on board ${event.boardId}`);
      }
      const events = rowsFrom<BoardEvent>(await tx.get(this.col(event.boardId, EVENTS)));
      tx.set(ref, toStored(event, nextSeq(events)));
    });
  }

  async listEvents(boardId: string, opts?: { limit?: number }): Promise<BoardEvent[]> {
    const all = sortedValues(rowsFrom<BoardEvent>(await this.col(boardId, EVENTS).get()));
    if (opts?.limit === undefined) return all;
    if (opts.limit <= 0) return [];
    return all.slice(-opts.limit);
  }

  /** Release the underlying gRPC client in scripts and tests. */
  async close(): Promise<void> {
    await this.db.terminate();
  }
}

export interface FirestoreBoardRepositoryOptions {
  projectId?: string | null;
  emulatorHost?: string | null;
}

export function createFirestoreBoardRepository(
  options: FirestoreBoardRepositoryOptions = {},
): FirestoreBoardRepository {
  const db = options.emulatorHost
    ? new Firestore({
        projectId: options.projectId ?? undefined,
        host: options.emulatorHost,
        ssl: false,
      })
    : new Firestore({ projectId: options.projectId ?? undefined });
  return new FirestoreBoardRepository(db);
}
