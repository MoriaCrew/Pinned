import "server-only";
/**
 * Firestore CreditLedgerStore (PIN-148): runs the pure ledger ops
 * (src/domain/credit-ledger.ts) inside one Firestore transaction
 * per board, the updateBoardSettings shape the store port asks
 * for. A throw from the pure op aborts the transaction, so a
 * refused operation writes nothing.
 *
 * Layout — multi-doc so no single document grows unbounded:
 * - creditAccounts/{boardId}: the account head only (balance,
 *   frozen, pendingClawback, starterGranted, frozenByDispute).
 * - creditAccounts/{boardId}/purchases/{purchaseId}: one doc per
 *   recorded purchase.
 * - creditAccounts/{boardId}/entries/{eventId}: one append-only
 *   doc per applied entry, keyed by its event id, carrying an
 *   internal `_seq` (append order, stripped on every read, the
 *   board-repository pattern).
 *
 * getAccount/listEntries reconstruct the domain account exactly:
 * entries sorted by `_seq`, `appliedEventIds` derived from the
 * entry ids in that order. Reads fetch whole subcollections and
 * sort in code, so no composite index is needed. Reconstructing
 * the full account per mutation is what the port's pure-op shape
 * requires (duplicate detection reads the applied event ids);
 * that adapter cost stays inside this store. getBalance is the
 * exception that keeps polls cheap (PIN-179): it reads the head
 * doc alone, outside any transaction.
 */
import {
  Firestore,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type QuerySnapshot,
} from "@google-cloud/firestore";
import {
  clawbackCredits,
  closePurchase as closePurchaseOp,
  creditBalanceView,
  debitCredits,
  emptyCreditAccount,
  freezeCredits,
  grantPurchase as grantPurchaseOp,
  grantStarter as grantStarterOp,
  recordPurchase as recordPurchaseOp,
  restoreCredits,
  type BoardCreditAccount,
  type ClawbackInput,
  type ClosePurchaseInput,
  type CreditApplyResult,
  type CreditBalanceView,
  type CreditLedgerEntry,
  type CreditLedgerStore,
  type CreditPurchase,
  type DebitInput,
  type FreezeInput,
  type PurchaseGrantInput,
  type RecordPurchaseInput,
  type RestoreInput,
  type StarterGrantInput,
} from "../domain/credit-ledger";

const CREDIT_ACCOUNTS = "creditAccounts";
const PURCHASES = "purchases";
const ENTRIES = "entries";

function toFirestoreData<T extends object>(value: T): DocumentData {
  return JSON.parse(JSON.stringify(value)) as DocumentData;
}

function assertBoardId(boardId: string): void {
  if (typeof boardId !== "string" || !boardId.trim()) {
    throw new RangeError("boardId must be a non-empty string");
  }
}

interface EntryRow {
  entry: CreditLedgerEntry;
  seq: number;
}

function entryRowsFrom(snapshot: QuerySnapshot): EntryRow[] {
  return snapshot.docs.map((doc) => {
    const { _seq, ...rest } = structuredClone(doc.data());
    return {
      entry: rest as unknown as CreditLedgerEntry,
      seq: typeof _seq === "number" ? _seq : 0,
    };
  });
}

function purchasesFrom(snapshot: QuerySnapshot): Record<string, CreditPurchase> {
  const purchases: Record<string, CreditPurchase> = {};
  for (const doc of snapshot.docs) {
    const purchase = structuredClone(doc.data()) as unknown as CreditPurchase;
    purchases[purchase.purchaseId] = purchase;
  }
  return purchases;
}

function sortedEntries(rows: EntryRow[]): CreditLedgerEntry[] {
  return [...rows].sort((a, b) => a.seq - b.seq).map((row) => row.entry);
}

function headFrom(boardId: string, data: DocumentData): BoardCreditAccount {
  return {
    boardId,
    balance: typeof data.balance === "number" ? data.balance : 0,
    frozen: typeof data.frozen === "number" ? data.frozen : 0,
    pendingClawback:
      typeof data.pendingClawback === "number" ? data.pendingClawback : 0,
    starterGranted: data.starterGranted === true,
    purchases: {},
    frozenByDispute:
      typeof data.frozenByDispute === "object" && data.frozenByDispute !== null
        ? (structuredClone(data.frozenByDispute) as Record<string, number>)
        : {},
    entries: [],
    appliedEventIds: [],
  };
}

function buildAccount(
  boardId: string,
  head: DocumentData,
  purchasesSnap: QuerySnapshot,
  entriesSnap: QuerySnapshot,
): BoardCreditAccount {
  const entries = sortedEntries(entryRowsFrom(entriesSnap));
  return {
    ...headFrom(boardId, head),
    purchases: purchasesFrom(purchasesSnap),
    entries,
    appliedEventIds: entries.map((entry) => entry.id),
  };
}

function cloneResult(result: CreditApplyResult): CreditApplyResult {
  return structuredClone(result);
}

export class FirestoreCreditLedgerStore implements CreditLedgerStore {
  constructor(private readonly db: Firestore) {}

  private accountRef(boardId: string): DocumentReference {
    return this.db.collection(CREDIT_ACCOUNTS).doc(boardId);
  }

  private purchasesCol(boardId: string): CollectionReference {
    return this.accountRef(boardId).collection(PURCHASES);
  }

  private entriesCol(boardId: string): CollectionReference {
    return this.accountRef(boardId).collection(ENTRIES);
  }

  private async apply(
    boardId: string,
    op: (account: BoardCreditAccount) => CreditApplyResult,
  ): Promise<CreditApplyResult> {
    assertBoardId(boardId);
    const accRef = this.accountRef(boardId);
    return this.db.runTransaction(async (tx) => {
      // All reads before writes (Firestore requirement).
      const headSnap = await tx.get(accRef);
      const purchasesSnap = await tx.get(this.purchasesCol(boardId));
      const entriesSnap = await tx.get(this.entriesCol(boardId));
      const current = headSnap.exists
        ? buildAccount(boardId, headSnap.data() as DocumentData, purchasesSnap, entriesSnap)
        : emptyCreditAccount(boardId);
      const result = op(structuredClone(current));
      // Mirror the in-memory store: a no-op against a never-created
      // account must not conjure one, and a no-op writes nothing.
      if (!result.applied) return cloneResult(result);
      const next = result.account;
      tx.set(
        accRef,
        toFirestoreData({
          boardId: next.boardId,
          balance: next.balance,
          frozen: next.frozen,
          pendingClawback: next.pendingClawback,
          starterGranted: next.starterGranted,
          frozenByDispute: next.frozenByDispute,
        }),
      );
      for (const purchase of Object.values(next.purchases)) {
        const before = current.purchases[purchase.purchaseId];
        if (!before || JSON.stringify(before) !== JSON.stringify(purchase)) {
          tx.set(
            this.purchasesCol(boardId).doc(encodeURIComponent(purchase.purchaseId)),
            toFirestoreData(purchase),
          );
        }
      }
      if (result.entry) {
        const rows = entryRowsFrom(entriesSnap);
        const nextSeq = rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
        tx.set(this.entriesCol(boardId).doc(encodeURIComponent(result.entry.id)), {
          ...toFirestoreData(result.entry),
          _seq: nextSeq,
        });
      }
      return cloneResult(result);
    });
  }

  async getAccount(boardId: string): Promise<BoardCreditAccount | null> {
    assertBoardId(boardId);
    const headSnap = await this.accountRef(boardId).get();
    if (!headSnap.exists) return null;
    const purchasesSnap = await this.purchasesCol(boardId).get();
    const entriesSnap = await this.entriesCol(boardId).get();
    return buildAccount(
      boardId,
      headSnap.data() as DocumentData,
      purchasesSnap,
      entriesSnap,
    );
  }

  /** The port's cheap read: one head-doc get, no transaction, no subcollections. */
  async getBalance(boardId: string): Promise<CreditBalanceView> {
    assertBoardId(boardId);
    const headSnap = await this.accountRef(boardId).get();
    const head = headSnap.exists
      ? headFrom(boardId, headSnap.data() as DocumentData)
      : emptyCreditAccount(boardId);
    return creditBalanceView(head);
  }

  async listEntries(boardId: string): Promise<CreditLedgerEntry[]> {
    assertBoardId(boardId);
    const entriesSnap = await this.entriesCol(boardId).get();
    return sortedEntries(entryRowsFrom(entriesSnap));
  }

  async grantStarter(boardId: string, input: StarterGrantInput): Promise<CreditApplyResult> {
    return this.apply(boardId, (account) => grantStarterOp(account, input));
  }

  async recordPurchase(boardId: string, input: RecordPurchaseInput): Promise<CreditApplyResult> {
    return this.apply(boardId, (account) => recordPurchaseOp(account, input));
  }

  async grantPurchase(boardId: string, input: PurchaseGrantInput): Promise<CreditApplyResult> {
    return this.apply(boardId, (account) => grantPurchaseOp(account, input));
  }

  async debit(boardId: string, input: DebitInput): Promise<CreditApplyResult> {
    return this.apply(boardId, (account) => debitCredits(account, input));
  }

  async clawback(boardId: string, input: ClawbackInput): Promise<CreditApplyResult> {
    return this.apply(boardId, (account) => clawbackCredits(account, input));
  }

  async freeze(boardId: string, input: FreezeInput): Promise<CreditApplyResult> {
    return this.apply(boardId, (account) => freezeCredits(account, input));
  }

  async restore(boardId: string, input: RestoreInput): Promise<CreditApplyResult> {
    return this.apply(boardId, (account) => restoreCredits(account, input));
  }

  async closePurchase(boardId: string, input: ClosePurchaseInput): Promise<CreditApplyResult> {
    return this.apply(boardId, (account) => closePurchaseOp(account, input));
  }
}

export interface FirestoreCreditLedgerStoreOptions {
  projectId?: string | null;
  emulatorHost?: string | null;
}

export function createFirestoreCreditLedgerStore(
  options: FirestoreCreditLedgerStoreOptions = {},
): FirestoreCreditLedgerStore {
  const db = options.emulatorHost
    ? new Firestore({
        projectId: options.projectId ?? undefined,
        host: options.emulatorHost,
        ssl: false,
      })
    : new Firestore({ projectId: options.projectId ?? undefined });
  return new FirestoreCreditLedgerStore(db);
}
