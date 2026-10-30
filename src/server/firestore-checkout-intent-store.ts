import "server-only";
/**
 * Firestore CheckoutIntentStore (PIN-148).
 *
 * Layout:
 * - checkoutIntents/{intentId}: the intent record, top-level by
 *   its opaque id so a webhook that knows only the intent id
 *   resolves it with one direct doc get — no board lookup, no
 *   collection query, no composite index.
 * - checkoutIntentBoards/{boardId}: `{ pendingIntentIds }`, the
 *   per-board pending index. `create` reads and rewrites this doc
 *   in its transaction (the participant-cap shape in
 *   firestore-board-repository.ts), so concurrent creates for one
 *   board contend on it and the cap re-evaluates against the
 *   winner's write. Transitions out of `pending` remove the id.
 *
 * Client access stays deny-all in firestore.rules; the stored
 * `boardId` is read only server-side and never enters the public
 * shape (see checkout-intent.ts).
 */
import {
  Firestore,
  type DocumentData,
  type DocumentReference,
} from "@google-cloud/firestore";
import {
  assertCreateCheckoutIntentInput,
  buildCheckoutIntent,
  capExceededError,
  isCheckoutIntentResolvable,
  mintCheckoutIntentId,
  partitionPendingIntents,
  type CheckoutIntent,
  type CheckoutIntentStore,
  type CheckoutIntentStoreOptions,
  type CreateCheckoutIntentInput,
} from "./checkout-intent";

const CHECKOUT_INTENTS = "checkoutIntents";
const CHECKOUT_INTENT_BOARDS = "checkoutIntentBoards";

function toFirestoreData<T extends object>(value: T): DocumentData {
  return JSON.parse(JSON.stringify(value)) as DocumentData;
}

function assertIntentId(intentId: string): void {
  if (typeof intentId !== "string" || !intentId.trim()) {
    throw new RangeError("intentId must be a non-empty string");
  }
}

function assertAt(at: number): void {
  if (!Number.isFinite(at) || at < 0) {
    throw new RangeError(`at must be a finite epoch-ms timestamp, got ${at}`);
  }
}

function intentFrom(data: DocumentData | undefined): CheckoutIntent | null {
  if (!data) return null;
  return structuredClone(data) as unknown as CheckoutIntent;
}

function pendingIdsFrom(data: DocumentData | undefined): string[] {
  if (!data || !Array.isArray(data.pendingIntentIds)) return [];
  return data.pendingIntentIds.filter(
    (id): id is string => typeof id === "string",
  );
}

export class FirestoreCheckoutIntentStore implements CheckoutIntentStore {
  constructor(
    private readonly db: Firestore,
    private readonly options: CheckoutIntentStoreOptions = {},
  ) {}

  private intentRef(intentId: string): DocumentReference {
    return this.db.collection(CHECKOUT_INTENTS).doc(intentId);
  }

  private boardIndexRef(boardId: string): DocumentReference {
    return this.db.collection(CHECKOUT_INTENT_BOARDS).doc(boardId);
  }

  async create(input: CreateCheckoutIntentInput): Promise<CheckoutIntent> {
    assertCreateCheckoutIntentInput(input);
    const intent = buildCheckoutIntent(mintCheckoutIntentId(this.options), input);
    const indexRef = this.boardIndexRef(input.boardId);
    return this.db.runTransaction(async (tx) => {
      // All reads before writes: the board index, every pending
      // intent it names, and the freshly minted id's doc.
      const indexSnap = await tx.get(indexRef);
      const pendingIds = pendingIdsFrom(
        indexSnap.exists ? indexSnap.data() : undefined,
      );
      const pending: CheckoutIntent[] = [];
      for (const pendingId of pendingIds) {
        const snap = await tx.get(this.intentRef(pendingId));
        const existing = intentFrom(snap.exists ? snap.data() : undefined);
        if (existing) pending.push(existing);
      }
      const freshSnap = await tx.get(this.intentRef(intent.id));
      if (freshSnap.exists) {
        throw new RangeError(`CheckoutIntent ${intent.id} already exists`);
      }
      const { live, stale } = partitionPendingIntents(pending, input.at);
      if (live.length >= input.pendingIntentCapPerBoard) {
        throw capExceededError(input.boardId, input.pendingIntentCapPerBoard);
      }
      for (const staleIntent of stale) {
        tx.set(
          this.intentRef(staleIntent.id),
          toFirestoreData({ ...staleIntent, status: "expired", closedAt: input.at }),
        );
      }
      tx.set(this.intentRef(intent.id), toFirestoreData(intent));
      tx.set(
        indexRef,
        toFirestoreData({
          boardId: input.boardId,
          pendingIntentIds: [...live.map((entry) => entry.id), intent.id],
        }),
      );
      return structuredClone(intent);
    });
  }

  async get(intentId: string): Promise<CheckoutIntent | null> {
    assertIntentId(intentId);
    const snap = await this.intentRef(intentId).get();
    return intentFrom(snap.exists ? snap.data() : undefined);
  }

  /**
   * Shared close/expire transition. `nextStatus` applies only to
   * a pending intent the caller passes the guard for; anything
   * else returns the stored record unchanged.
   */
  private async transition(
    intentId: string,
    at: number,
    nextStatus: "closed" | "expired",
    applies: (intent: CheckoutIntent) => boolean,
  ): Promise<CheckoutIntent | null> {
    assertIntentId(intentId);
    assertAt(at);
    const ref = this.intentRef(intentId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const intent = intentFrom(snap.exists ? snap.data() : undefined);
      if (!intent) return null;
      if (intent.status !== "pending" || !applies(intent)) {
        return structuredClone(intent);
      }
      const indexRef = this.boardIndexRef(intent.boardId);
      const indexSnap = await tx.get(indexRef);
      const next: CheckoutIntent = { ...intent, status: nextStatus, closedAt: at };
      tx.set(ref, toFirestoreData(next));
      tx.set(
        indexRef,
        toFirestoreData({
          boardId: intent.boardId,
          pendingIntentIds: pendingIdsFrom(
            indexSnap.exists ? indexSnap.data() : undefined,
          ).filter((id) => id !== intentId),
        }),
      );
      return structuredClone(next);
    });
  }

  async resolvePending(intentId: string, at: number): Promise<CheckoutIntent | null> {
    assertIntentId(intentId);
    assertAt(at);
    const ref = this.intentRef(intentId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const intent = intentFrom(snap.exists ? snap.data() : undefined);
      if (!intent) return null;
      if (intent.status === "pending" && at >= intent.expiresAt) {
        const indexRef = this.boardIndexRef(intent.boardId);
        const indexSnap = await tx.get(indexRef);
        tx.set(
          ref,
          toFirestoreData({ ...intent, status: "expired", closedAt: at }),
        );
        tx.set(
          indexRef,
          toFirestoreData({
            boardId: intent.boardId,
            pendingIntentIds: pendingIdsFrom(
              indexSnap.exists ? indexSnap.data() : undefined,
            ).filter((id) => id !== intentId),
          }),
        );
        return null;
      }
      return isCheckoutIntentResolvable(intent, at)
        ? structuredClone(intent)
        : null;
    });
  }

  async close(intentId: string, at: number): Promise<CheckoutIntent | null> {
    return this.transition(intentId, at, "closed", () => true);
  }

  async expire(intentId: string, at: number): Promise<CheckoutIntent | null> {
    return this.transition(
      intentId,
      at,
      "expired",
      (intent) => at >= intent.expiresAt,
    );
  }
}

export interface FirestoreCheckoutIntentStoreOptions
  extends CheckoutIntentStoreOptions {
  projectId?: string | null;
  emulatorHost?: string | null;
}

export function createFirestoreCheckoutIntentStore(
  options: FirestoreCheckoutIntentStoreOptions = {},
): FirestoreCheckoutIntentStore {
  const db = options.emulatorHost
    ? new Firestore({
        projectId: options.projectId ?? undefined,
        host: options.emulatorHost,
        ssl: false,
      })
    : new Firestore({ projectId: options.projectId ?? undefined });
  return new FirestoreCheckoutIntentStore(db, { newId: options.newId });
}
