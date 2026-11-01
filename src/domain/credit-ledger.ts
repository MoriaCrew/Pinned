/**
 * Board credit ("makes") ledger (PIN-147, docs/15-board-plus.md).
 * Pure domain + store port: no Stripe calls, no env, no wiring
 * into the board loop — amounts come from Policy.credits at the
 * caller (this module never imports Policy, so Policy can keep
 * importing domain modules without a cycle).
 *
 * THE MODEL (explicit, every rule below is tested):
 *
 * Per board the account tracks three counters:
 * - `balance`: makes the board owns right now (grants credited,
 *   minus debits, minus clawbacks taken from the pool). Never
 *   negative.
 * - `frozen`: the subset of `balance` held by open disputes
 *   (`frozenByDispute` is its per-dispute breakdown; the two
 *   always sum equal). Frozen makes cannot be spent.
 * - `pendingClawback`: make-debt owed because a clawback exceeded
 *   the unspent pool. It is NOT part of `balance`; every future
 *   grant (starter or purchase) pays it down FIRST and only the
 *   remainder lands in `balance`.
 *
 * AVAILABILITY FORMULA (the one debit and freeze enforce):
 *   available = max(0, balance - frozen - pendingClawback)
 * Reachable states never hold `balance > 0` while
 * `pendingClawback > 0` (a clawback drains the pool before
 * creating debt, and a grant pays debt before crediting), so the
 * `- pendingClawback` term never double-counts; it stays in the
 * formula so a corrupt stored state fails closed instead of
 * spending makes that are already owed back.
 *
 * Every mutation is a pure function of the stored account
 * returning `{ account, applied, entry? }`: the input is never
 * mutated, `applied: false` means an idempotent no-op (same
 * account back, no entry appended), and invalid operations throw
 * RangeError (repo convention) having written nothing. Duplicate
 * detection is layered: every entry-producing event carries a
 * globally unique `eventId` (a replay is a no-op), purchase
 * grants are additionally idempotent by `purchaseId`, refund
 * clawbacks by `refundId`, freezes by `disputeId`, and the
 * starter grant is once per board ever.
 */

export const CREDIT_ENTRY_TYPES = [
  "starter_grant",
  "purchase_grant",
  "debit",
  "debit_refund",
  "clawback",
  "freeze",
  "restore",
] as const;
export type CreditEntryType = (typeof CREDIT_ENTRY_TYPES)[number];

export const CREDIT_PURCHASE_STATES = [
  "pending",
  "granted",
  "clawed_back",
  "closed",
] as const;
export type CreditPurchaseState = (typeof CREDIT_PURCHASE_STATES)[number];

/** One recorded (not necessarily paid) pack purchase. */
export interface CreditPurchase {
  purchaseId: string;
  /** Pack size recorded at intent time; the grant credits exactly this. */
  credits: number;
  state: CreditPurchaseState;
  /** Gross makes credited by the grant (0 until granted; then `credits`). */
  grantedCredits: number;
  /** Total makes clawed back against this purchase (refunds + final dispute clawbacks), including pre-grant ones. Never exceeds `credits`. */
  clawedCredits: number;
  /** Applied per-refund delta ids, in apply order. A repeat id is a no-op. */
  refundIds: string[];
  /** Dispute freezes recorded before the grant landed, by dispute id. Applied (capped at what's actually credited) by the grant, then cleared. */
  deferredFreezes: Record<string, number>;
  /** Disputes resolved (restored in full, or final-clawed with no hold left). A late freeze for one is a no-op, even when the restore arrived before any freeze. */
  resolvedDisputeIds: string[];
}

export interface CreditLedgerEntry {
  /** The causing event's id (globally unique; replays are no-ops). */
  id: string;
  boardId: string;
  type: CreditEntryType;
  /** Gross makes the event concerns (pack size, refund delta, dispute amount...). */
  amount: number;
  /** Signed change this entry made to `balance` after netting/offsets. */
  balanceDelta: number;
  frozenDelta: number;
  pendingClawbackDelta: number;
  purchaseId?: string;
  refundId?: string;
  disputeId?: string;
  /** For debit_refund entries: the debit entry this refunds. */
  debitEventId?: string;
  balanceAfter: number;
  frozenAfter: number;
  pendingClawbackAfter: number;
  availableAfter: number;
  createdAt: number;
}

export interface BoardCreditAccount {
  boardId: string;
  balance: number;
  frozen: number;
  pendingClawback: number;
  starterGranted: boolean;
  purchases: Record<string, CreditPurchase>;
  /** Open dispute holds summing exactly to `frozen`. */
  frozenByDispute: Record<string, number>;
  entries: CreditLedgerEntry[];
  /** Event ids that produced an entry, for replay detection. */
  appliedEventIds: string[];
}

/** The account head as one cheap read: counters, starter flag, derived `available`. */
export interface CreditBalanceView {
  boardId: string;
  balance: number;
  frozen: number;
  pendingClawback: number;
  /** Lets a credit touch skip the transactional starter grant (PIN-179). */
  starterGranted: boolean;
  available: number;
}

export function emptyCreditAccount(boardId: string): BoardCreditAccount {
  assertId(boardId, "boardId");
  return {
    boardId,
    balance: 0,
    frozen: 0,
    pendingClawback: 0,
    starterGranted: false,
    purchases: {},
    frozenByDispute: {},
    entries: [],
    appliedEventIds: [],
  };
}

/** The availability formula documented above. The only spendable count. */
export function availableCredits(
  account: Pick<BoardCreditAccount, "balance" | "frozen" | "pendingClawback">,
): number {
  return Math.max(0, account.balance - account.frozen - account.pendingClawback);
}

export function creditBalanceView(account: BoardCreditAccount): CreditBalanceView {
  return {
    boardId: account.boardId,
    balance: account.balance,
    frozen: account.frozen,
    pendingClawback: account.pendingClawback,
    starterGranted: account.starterGranted,
    available: availableCredits(account),
  };
}

// ---------------------------------------------------------------------------
// Inputs and results
// ---------------------------------------------------------------------------

interface CreditEventInput {
  eventId: string;
  at: number;
}

export interface StarterGrantInput extends CreditEventInput {
  /** Policy.credits.starterMakes at grant time; 0 still marks the once-only grant done. */
  amount: number;
}

export interface RecordPurchaseInput {
  purchaseId: string;
  credits: number;
}

export interface PurchaseGrantInput extends CreditEventInput {
  purchaseId: string;
}

export interface DebitInput extends CreditEventInput {
  amount: number;
}

export interface RefundDebitInput extends CreditEventInput {
  /** The debit entry to refund in full; its recorded amount is re-credited. */
  debitEventId: string;
}

export interface ClawbackInput extends CreditEventInput {
  purchaseId: string;
  amount: number;
  /** Per-refund delta identity: the same refund id never claws back twice. */
  refundId?: string;
  /** Set when this is a dispute's final clawback: its frozen makes are consumed first. */
  disputeId?: string;
}

export interface FreezeInput extends CreditEventInput {
  purchaseId: string;
  disputeId: string;
  amount: number;
}

export interface RestoreInput extends CreditEventInput {
  purchaseId: string;
  disputeId: string;
  /** Defaults to the dispute's whole remaining hold. */
  amount?: number;
}

export interface ClosePurchaseInput {
  purchaseId: string;
}

export interface CreditApplyResult {
  account: BoardCreditAccount;
  applied: boolean;
  entry?: CreditLedgerEntry;
}

// ---------------------------------------------------------------------------
// Validation + internal helpers (all fail closed with RangeError)
// ---------------------------------------------------------------------------

function assertId(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new RangeError(`${name} must be a non-empty string`);
  }
}

function assertAmount(value: number, name: string, allowZero = false): void {
  if (!Number.isInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new RangeError(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} integer, got ${value}`,
    );
  }
}

function assertAt(at: number): void {
  if (!Number.isFinite(at) || at < 0) {
    throw new RangeError(`at must be a finite epoch-ms timestamp, got ${at}`);
  }
}

function getPurchase(account: BoardCreditAccount, purchaseId: string): CreditPurchase {
  assertId(purchaseId, "purchaseId");
  const purchase = account.purchases[purchaseId];
  if (!purchase) {
    throw new RangeError(`Purchase ${purchaseId} not found on board ${account.boardId}`);
  }
  return purchase;
}

/** Structural invariants every reachable account satisfies; checked after each applied op. */
export function assertCreditAccountInvariants(account: BoardCreditAccount): void {
  const fail = (message: string): never => {
    throw new RangeError(`Credit account invariant violated on board ${account.boardId}: ${message}`);
  };
  if (!Number.isInteger(account.balance) || account.balance < 0) fail("balance must be a non-negative integer");
  if (!Number.isInteger(account.frozen) || account.frozen < 0 || account.frozen > account.balance) {
    fail("frozen must satisfy 0 <= frozen <= balance");
  }
  if (!Number.isInteger(account.pendingClawback) || account.pendingClawback < 0) {
    fail("pendingClawback must be a non-negative integer");
  }
  if (account.pendingClawback > 0 && account.balance !== 0) {
    fail("pendingClawback > 0 requires balance === 0 (grants pay debt before crediting)");
  }
  const frozenSum = Object.values(account.frozenByDispute).reduce((sum, n) => sum + n, 0);
  if (frozenSum !== account.frozen) fail("frozenByDispute must sum to frozen");
  for (const purchase of Object.values(account.purchases)) {
    if (purchase.clawedCredits < 0 || purchase.clawedCredits > purchase.credits) {
      fail(`purchase ${purchase.purchaseId} clawedCredits out of range`);
    }
    if (purchase.grantedCredits !== 0 && purchase.grantedCredits !== purchase.credits) {
      fail(`purchase ${purchase.purchaseId} grantedCredits must be 0 or the pack size`);
    }
  }
}

interface EntryDraft {
  debitEventId?: string;
  id: string;
  type: CreditEntryType;
  amount: number;
  balanceDelta: number;
  frozenDelta: number;
  pendingClawbackDelta: number;
  purchaseId?: string;
  refundId?: string;
  disputeId?: string;
  createdAt: number;
}

/** Append the entry to the (already mutated) clone and stamp the after-state. */
function finishWithEntry(next: BoardCreditAccount, draft: EntryDraft): CreditApplyResult {
  assertCreditAccountInvariants(next);
  const entry: CreditLedgerEntry = {
    ...draft,
    boardId: next.boardId,
    balanceAfter: next.balance,
    frozenAfter: next.frozen,
    pendingClawbackAfter: next.pendingClawback,
    availableAfter: availableCredits(next),
  };
  next.entries.push(entry);
  next.appliedEventIds.push(draft.id);
  return { account: next, applied: true, entry: structuredClone(entry) };
}

function noOp(account: BoardCreditAccount): CreditApplyResult {
  return { account, applied: false };
}

function alreadyApplied(account: BoardCreditAccount, eventId: string): boolean {
  assertId(eventId, "eventId");
  return account.appliedEventIds.includes(eventId);
}

/**
 * Credit `amount` gross makes: pay down pendingClawback first,
 * credit only the remainder. Returns the two deltas.
 */
function applyGrantToPool(
  next: BoardCreditAccount,
  amount: number,
): { balanceDelta: number; pendingClawbackDelta: number } {
  const offset = Math.min(amount, next.pendingClawback);
  next.pendingClawback -= offset;
  const credited = amount - offset;
  next.balance += credited;
  return { balanceDelta: credited, pendingClawbackDelta: -offset };
}

/** Reduce the frozen total by `amount`, consuming `preferredDisputeId`'s hold first, then oldest holds. Returns actual frozenDelta (<= 0). */
function reduceFrozen(
  next: BoardCreditAccount,
  amount: number,
  preferredDisputeId?: string,
): number {
  let remaining = Math.min(amount, next.frozen);
  const reduced = remaining;
  const consume = (disputeId: string): void => {
    if (remaining <= 0) return;
    const held = next.frozenByDispute[disputeId] ?? 0;
    const take = Math.min(held, remaining);
    if (take === held) delete next.frozenByDispute[disputeId];
    else if (take > 0) next.frozenByDispute[disputeId] = held - take;
    remaining -= take;
  };
  if (preferredDisputeId) consume(preferredDisputeId);
  for (const disputeId of Object.keys(next.frozenByDispute)) consume(disputeId);
  next.frozen -= reduced;
  return -reduced;
}

// ---------------------------------------------------------------------------
function markDisputeResolved(target: CreditPurchase, disputeId: string): void {
  if (!target.resolvedDisputeIds.includes(disputeId)) target.resolvedDisputeIds.push(disputeId);
}

// Pure operations. None mutates its input; applied ops work on a clone.
// ---------------------------------------------------------------------------

/** The once-per-board free starter pool. A second grant (any event id) is a no-op. */
export function grantStarter(
  account: BoardCreditAccount,
  input: StarterGrantInput,
): CreditApplyResult {
  assertAmount(input.amount, "amount", true);
  assertAt(input.at);
  if (alreadyApplied(account, input.eventId) || account.starterGranted) return noOp(account);
  const next = structuredClone(account);
  next.starterGranted = true;
  const { balanceDelta, pendingClawbackDelta } = applyGrantToPool(next, input.amount);
  return finishWithEntry(next, {
    id: input.eventId,
    type: "starter_grant",
    amount: input.amount,
    balanceDelta,
    frozenDelta: 0,
    pendingClawbackDelta,
    createdAt: input.at,
  });
}

/**
 * Record a purchase intent in `pending` (no entry: nothing is
 * owned yet). Re-recording the same id + pack size is a no-op; the
 * same id with a different pack size throws — a purchase's size
 * never changes under its id.
 */
export function recordPurchase(
  account: BoardCreditAccount,
  input: RecordPurchaseInput,
): CreditApplyResult {
  assertId(input.purchaseId, "purchaseId");
  assertAmount(input.credits, "credits");
  const existing = account.purchases[input.purchaseId];
  if (existing) {
    if (existing.credits !== input.credits) {
      throw new RangeError(
        `Purchase ${input.purchaseId} already recorded with ${existing.credits} credits, got ${input.credits}`,
      );
    }
    return noOp(account);
  }
  const next = structuredClone(account);
  next.purchases[input.purchaseId] = {
    purchaseId: input.purchaseId,
    credits: input.credits,
    state: "pending",
    grantedCredits: 0,
    clawedCredits: 0,
    refundIds: [],
    deferredFreezes: {},
    resolvedDisputeIds: [],
  };
  assertCreditAccountInvariants(next);
  return { account: next, applied: true };
}

/**
 * Grant a paid purchase, idempotent by purchase id (a granted or
 * clawed-back purchase never grants twice). Pre-grant clawbacks
 * recorded against the pending purchase net against the grant:
 * only `credits - clawedCredits` is credited (then paying down any
 * board pendingClawback like every grant), so a fully
 * clawed-back-before-grant purchase nets to exactly zero and ends
 * `clawed_back`. Deferred dispute freezes take effect here, capped
 * at what actually landed in the pool.
 */
export function grantPurchase(
  account: BoardCreditAccount,
  input: PurchaseGrantInput,
): CreditApplyResult {
  assertAt(input.at);
  if (alreadyApplied(account, input.eventId)) return noOp(account);
  const purchase = getPurchase(account, input.purchaseId);
  if (purchase.state === "closed") {
    throw new RangeError(`Purchase ${input.purchaseId} is closed and cannot grant`);
  }
  if (purchase.grantedCredits > 0) return noOp(account);

  const next = structuredClone(account);
  const target = next.purchases[input.purchaseId];
  const netGrant = target.credits - target.clawedCredits;
  const { balanceDelta, pendingClawbackDelta } = applyGrantToPool(next, netGrant);
  target.grantedCredits = target.credits;
  let freezeBudget = balanceDelta;

  let frozenDelta = 0;
  for (const [disputeId, wanted] of Object.entries(target.deferredFreezes)) {
    const canFreeze = freezeBudget;
    const appliedFreeze = Math.min(wanted, Math.max(0, canFreeze));
    if (appliedFreeze > 0) {
      next.frozen += appliedFreeze;
      next.frozenByDispute[disputeId] = (next.frozenByDispute[disputeId] ?? 0) + appliedFreeze;
      frozenDelta += appliedFreeze;
      freezeBudget -= appliedFreeze;
    }
  }
  target.deferredFreezes = {};
  target.state = target.clawedCredits >= target.credits ? "clawed_back" : "granted";

  return finishWithEntry(next, {
    id: input.eventId,
    type: "purchase_grant",
    amount: target.credits,
    balanceDelta,
    frozenDelta,
    pendingClawbackDelta,
    purchaseId: input.purchaseId,
    createdAt: input.at,
  });
}

/** Spend makes (debit-on-success is the caller's call). Only `available` can be spent; anything more throws and writes nothing. */
export function debitCredits(
  account: BoardCreditAccount,
  input: DebitInput,
): CreditApplyResult {
  assertAmount(input.amount, "amount");
  assertAt(input.at);
  if (alreadyApplied(account, input.eventId)) return noOp(account);
  const available = availableCredits(account);
  if (input.amount > available) {
    throw new RangeError(
      `Debit of ${input.amount} exceeds available ${available} on board ${account.boardId}`,
    );
  }
  const next = structuredClone(account);
  next.balance -= input.amount;
  return finishWithEntry(next, {
    id: input.eventId,
    type: "debit",
    amount: input.amount,
    balanceDelta: -input.amount,
    frozenDelta: 0,
    pendingClawbackDelta: 0,
    createdAt: input.at,
  });
}

/**
 * Claw back makes for a refund delta or a dispute's final outcome.
 * - Duplicate `refundId` (per purchase): no-op, however it arrives.
 * - Before the grant: recorded against the pending purchase only;
 *   no pool movement (the later grant nets it out).
 * - After the grant: unspent makes leave the pool first; any
 *   shortfall becomes `pendingClawback`. A disputed purchase's
 *   frozen makes are consumed first when `disputeId` is set, and
 *   `frozen` is clamped to the shrunken pool.
 * Total clawbacks against one purchase never exceed its pack size.
 */
/**
 * Refund one applied debit in full (a make whose result could not be
 * exposed, e.g. a decompose runner that lost its guarded finish after
 * debiting). Idempotent two ways: by this refund's event id, and per
 * debit — a second refund naming the same debit under any event id is
 * a no-op. Refunding an unknown debit throws and writes nothing. The
 * re-credit pays down pendingClawback first, like every grant.
 */
export function refundDebit(
  account: BoardCreditAccount,
  input: RefundDebitInput,
): CreditApplyResult {
  assertAt(input.at);
  assertId(input.debitEventId, "debitEventId");
  if (alreadyApplied(account, input.eventId)) return noOp(account);
  const debit = account.entries.find(
    (entry) => entry.type === "debit" && entry.id === input.debitEventId,
  );
  if (!debit) {
    throw new RangeError(
      `Debit ${input.debitEventId} not found on board ${account.boardId}`,
    );
  }
  const alreadyRefunded = account.entries.some(
    (entry) => entry.type === "debit_refund" && entry.debitEventId === input.debitEventId,
  );
  if (alreadyRefunded) return noOp(account);
  const next = structuredClone(account);
  const { balanceDelta, pendingClawbackDelta } = applyGrantToPool(next, debit.amount);
  return finishWithEntry(next, {
    id: input.eventId,
    type: "debit_refund",
    amount: debit.amount,
    balanceDelta,
    frozenDelta: 0,
    pendingClawbackDelta,
    debitEventId: input.debitEventId,
    createdAt: input.at,
  });
}

export function clawbackCredits(
  account: BoardCreditAccount,
  input: ClawbackInput,
): CreditApplyResult {
  assertAmount(input.amount, "amount");
  assertAt(input.at);
  if (input.refundId !== undefined) assertId(input.refundId, "refundId");
  if (input.disputeId !== undefined) assertId(input.disputeId, "disputeId");
  if (alreadyApplied(account, input.eventId)) return noOp(account);
  const purchase = getPurchase(account, input.purchaseId);
  if (input.refundId && purchase.refundIds.includes(input.refundId)) return noOp(account);
  if (purchase.state === "closed") {
    throw new RangeError(`Purchase ${input.purchaseId} is closed and cannot be clawed back`);
  }
  if (purchase.clawedCredits + input.amount > purchase.credits) {
    throw new RangeError(
      `Clawback of ${input.amount} would take purchase ${input.purchaseId} past its ${purchase.credits} credits (already clawed ${purchase.clawedCredits})`,
    );
  }

  const next = structuredClone(account);
  const target = next.purchases[input.purchaseId];
  target.clawedCredits += input.amount;
  if (input.refundId) target.refundIds.push(input.refundId);

  let balanceDelta = 0;
  let frozenDelta = 0;
  let pendingClawbackDelta = 0;
  if (target.grantedCredits > 0) {
    if (input.disputeId) {
      // Only this dispute's own hold (PIN-233 F4): another open
      // dispute's makes stay frozen. Any shortfall comes from the
      // pool below, and the clamp after it trims holds only when
      // the shrunken pool can no longer back them.
      const ownHold = next.frozenByDispute[input.disputeId] ?? 0;
      frozenDelta += reduceFrozen(next, Math.min(input.amount, ownHold), input.disputeId);
    }
    const taken = Math.min(input.amount, next.balance);
    next.balance -= taken;
    balanceDelta = -taken;
    pendingClawbackDelta = input.amount - taken;
    next.pendingClawback += pendingClawbackDelta;
    if (next.frozen > next.balance) {
      frozenDelta += reduceFrozen(next, next.frozen - next.balance);
    }
    if (input.disputeId && (next.frozenByDispute[input.disputeId] ?? 0) === 0) {
      markDisputeResolved(target, input.disputeId);
    }
    if (target.clawedCredits >= target.credits) target.state = "clawed_back";
  } else if (input.disputeId) {
    // Final clawback for a dispute frozen pre-grant: the deferred
    // hold is moot once those makes are clawed back on paper.
    const held = target.deferredFreezes[input.disputeId] ?? 0;
    if (input.amount >= held) {
      delete target.deferredFreezes[input.disputeId];
      markDisputeResolved(target, input.disputeId);
    }
    else target.deferredFreezes[input.disputeId] = held - input.amount;
  }

  return finishWithEntry(next, {
    id: input.eventId,
    type: "clawback",
    amount: input.amount,
    balanceDelta,
    frozenDelta,
    pendingClawbackDelta,
    purchaseId: input.purchaseId,
    ...(input.refundId ? { refundId: input.refundId } : {}),
    ...(input.disputeId ? { disputeId: input.disputeId } : {}),
    createdAt: input.at,
  });
}

/**
 * Freeze disputed makes so they cannot be spent until a restore or
 * the dispute's final clawback. The amount is capped at what is still
 * clawable from the disputed purchase (`credits - clawedCredits`), so
 * a dispute after a partial refund never holds other makes; a fully
 * clawed purchase has nothing to freeze and throws. On a granted
 * purchase the capped amount must fit inside `available`
 * (spent/frozen makes cannot freeze again — the caller freezes what
 * remains). Before the grant the freeze is recorded as deferred and
 * takes effect at grant time. The same dispute freezing twice is a
 * no-op.
 */
export function freezeCredits(
  account: BoardCreditAccount,
  input: FreezeInput,
): CreditApplyResult {
  assertAmount(input.amount, "amount");
  assertAt(input.at);
  assertId(input.disputeId, "disputeId");
  if (alreadyApplied(account, input.eventId)) return noOp(account);
  const purchase = getPurchase(account, input.purchaseId);
  if (purchase.resolvedDisputeIds.includes(input.disputeId)) return noOp(account);
  if (purchase.state === "closed" || purchase.state === "clawed_back") {
    throw new RangeError(`Purchase ${input.purchaseId} is ${purchase.state} and cannot freeze`);
  }
  if (
    account.frozenByDispute[input.disputeId] !== undefined ||
    purchase.deferredFreezes[input.disputeId] !== undefined
  ) {
    return noOp(account);
  }

  // A dispute can only take back what is still clawable from its own
  // purchase (PIN-233 F5): after a partial refund, a hold above that
  // remainder would lock the starter's or other packs' makes.
  const clawable = purchase.credits - purchase.clawedCredits;
  if (clawable <= 0) {
    throw new RangeError(`Purchase ${input.purchaseId} has no clawable makes left to freeze`);
  }
  const amount = Math.min(input.amount, clawable);

  const next = structuredClone(account);
  const target = next.purchases[input.purchaseId];
  let frozenDelta = 0;
  if (target.grantedCredits > 0) {
    const available = availableCredits(next);
    if (amount > available) {
      throw new RangeError(
        `Freeze of ${amount} exceeds available ${available} on board ${account.boardId}`,
      );
    }
    next.frozen += amount;
    next.frozenByDispute[input.disputeId] = amount;
    frozenDelta = amount;
  } else {
    target.deferredFreezes[input.disputeId] = amount;
  }

  return finishWithEntry(next, {
    id: input.eventId,
    type: "freeze",
    amount,
    balanceDelta: 0,
    frozenDelta,
    pendingClawbackDelta: 0,
    purchaseId: input.purchaseId,
    disputeId: input.disputeId,
    createdAt: input.at,
  });
}

/**
 * Release a dispute hold (dispute won/closed in the board's
 * favour). Restoring a dispute with no remaining hold — a
 * duplicate restore, or one already consumed by a final clawback —
 * is a no-op. Restoring more than the dispute holds throws.
 */
export function restoreCredits(
  account: BoardCreditAccount,
  input: RestoreInput,
): CreditApplyResult {
  if (input.amount !== undefined) assertAmount(input.amount, "amount");
  assertAt(input.at);
  assertId(input.disputeId, "disputeId");
  if (alreadyApplied(account, input.eventId)) return noOp(account);
  const purchase = getPurchase(account, input.purchaseId);

  const liveHold = account.frozenByDispute[input.disputeId] ?? 0;
  const deferredHold = purchase.deferredFreezes[input.disputeId] ?? 0;
  if (liveHold === 0 && deferredHold === 0) {
    if (
      purchase.resolvedDisputeIds.includes(input.disputeId) ||
      purchase.state === "closed" ||
      purchase.state === "clawed_back"
    ) {
      return noOp(account);
    }
    const next = structuredClone(account);
    markDisputeResolved(next.purchases[input.purchaseId], input.disputeId);
    return finishWithEntry(next, {
      id: input.eventId,
      type: "restore",
      amount: input.amount ?? 0,
      balanceDelta: 0,
      frozenDelta: 0,
      pendingClawbackDelta: 0,
      purchaseId: input.purchaseId,
      disputeId: input.disputeId,
      createdAt: input.at,
    });
  }

  const next = structuredClone(account);
  const target = next.purchases[input.purchaseId];
  let frozenDelta = 0;
  let amount: number;
  if (liveHold > 0) {
    amount = input.amount ?? liveHold;
    if (amount > liveHold) {
      throw new RangeError(
        `Restore of ${amount} exceeds disputed hold ${liveHold} on board ${account.boardId}`,
      );
    }
    frozenDelta = reduceFrozen(next, amount, input.disputeId);
    if (amount === liveHold) markDisputeResolved(target, input.disputeId);
  } else {
    amount = input.amount ?? deferredHold;
    if (amount > deferredHold) {
      throw new RangeError(
        `Restore of ${amount} exceeds deferred disputed hold ${deferredHold} on board ${account.boardId}`,
      );
    }
    if (amount === deferredHold) {
      delete target.deferredFreezes[input.disputeId];
      markDisputeResolved(target, input.disputeId);
    }
    else target.deferredFreezes[input.disputeId] = deferredHold - amount;
  }

  return finishWithEntry(next, {
    id: input.eventId,
    type: "restore",
    amount,
    balanceDelta: 0,
    frozenDelta,
    pendingClawbackDelta: 0,
    purchaseId: input.purchaseId,
    disputeId: input.disputeId,
    createdAt: input.at,
  });
}

/**
 * Close a pending purchase that will never grant (intent expired
 * or abandoned). No entry: nothing was owned. A purchase with
 * pre-grant clawbacks covering the whole pack closes as
 * `clawed_back` instead (it nets to zero without a grant ever
 * landing); a partially pre-clawed purchase must await its grant
 * so the netting is recorded, and a granted purchase cannot close.
 * Closing a terminal purchase again is a no-op.
 */
export function closePurchase(
  account: BoardCreditAccount,
  input: ClosePurchaseInput,
): CreditApplyResult {
  const purchase = getPurchase(account, input.purchaseId);
  if (purchase.state === "closed" || purchase.state === "clawed_back") return noOp(account);
  if (purchase.grantedCredits > 0) {
    throw new RangeError(`Purchase ${input.purchaseId} already granted and cannot close`);
  }
  if (purchase.clawedCredits > 0 && purchase.clawedCredits < purchase.credits) {
    throw new RangeError(
      `Purchase ${input.purchaseId} is partially clawed back before grant; it must grant to net out`,
    );
  }
  if (Object.keys(purchase.deferredFreezes).length > 0 && purchase.clawedCredits === 0) {
    throw new RangeError(`Purchase ${input.purchaseId} has an open dispute freeze and cannot close`);
  }
  const next = structuredClone(account);
  const target = next.purchases[input.purchaseId];
  target.state = target.clawedCredits >= target.credits ? "clawed_back" : "closed";
  target.deferredFreezes = {};
  assertCreditAccountInvariants(next);
  return { account: next, applied: true };
}

// ---------------------------------------------------------------------------
// Store port + in-memory implementation
// ---------------------------------------------------------------------------

/**
 * Per-board transactional store. Every mutating method applies one
 * pure operation above against the board's current account as a
 * single atomic read-modify-write: a Firestore implementation must
 * run the pure function inside its transaction (the
 * `updateBoardSettings` shape), and a throw writes nothing.
 * Accounts are created lazily by the first applied mutation; reads
 * of an unknown board report a zero balance rather than throwing,
 * mirroring "this board has no makes yet".
 *
 * `getBalance` is the cheap read (PIN-179): the account head only,
 * no transaction and no purchases/entries — one document read in
 * Firestore. Board polls, the photo preflight and the scene run
 * call it on every touch, so it must stay that cheap.
 */
export interface CreditLedgerStore {
  getAccount(boardId: string): Promise<BoardCreditAccount | null>;
  getBalance(boardId: string): Promise<CreditBalanceView>;
  listEntries(boardId: string): Promise<CreditLedgerEntry[]>;
  grantStarter(boardId: string, input: StarterGrantInput): Promise<CreditApplyResult>;
  recordPurchase(boardId: string, input: RecordPurchaseInput): Promise<CreditApplyResult>;
  grantPurchase(boardId: string, input: PurchaseGrantInput): Promise<CreditApplyResult>;
  debit(boardId: string, input: DebitInput): Promise<CreditApplyResult>;
  refundDebit(boardId: string, input: RefundDebitInput): Promise<CreditApplyResult>;
  clawback(boardId: string, input: ClawbackInput): Promise<CreditApplyResult>;
  freeze(boardId: string, input: FreezeInput): Promise<CreditApplyResult>;
  restore(boardId: string, input: RestoreInput): Promise<CreditApplyResult>;
  closePurchase(boardId: string, input: ClosePurchaseInput): Promise<CreditApplyResult>;
}

/** In-memory store: the test double and the port's contract. Method bodies never await between read and write, so each call is atomic per board. */
export class InMemoryCreditLedgerStore implements CreditLedgerStore {
  private readonly accounts = new Map<string, BoardCreditAccount>();

  private apply(
    boardId: string,
    op: (account: BoardCreditAccount) => CreditApplyResult,
  ): CreditApplyResult {
    assertId(boardId, "boardId");
    const current = this.accounts.get(boardId) ?? emptyCreditAccount(boardId);
    const result = op(structuredClone(current));
    // A no-op against a never-created account must not conjure one.
    if (result.applied || this.accounts.has(boardId)) {
      this.accounts.set(boardId, structuredClone(result.account));
    }
    return { ...result, account: structuredClone(result.account) };
  }

  async getAccount(boardId: string): Promise<BoardCreditAccount | null> {
    assertId(boardId, "boardId");
    const account = this.accounts.get(boardId);
    return account ? structuredClone(account) : null;
  }

  async getBalance(boardId: string): Promise<CreditBalanceView> {
    assertId(boardId, "boardId");
    // Head fields only, no account clone: mirrors the Firestore head-doc read.
    return creditBalanceView(this.accounts.get(boardId) ?? emptyCreditAccount(boardId));
  }

  async listEntries(boardId: string): Promise<CreditLedgerEntry[]> {
    const account = await this.getAccount(boardId);
    return account ? structuredClone(account.entries) : [];
  }

  async grantStarter(boardId: string, input: StarterGrantInput): Promise<CreditApplyResult> {
    return this.apply(boardId, (account) => grantStarter(account, input));
  }

  async recordPurchase(boardId: string, input: RecordPurchaseInput): Promise<CreditApplyResult> {
    return this.apply(boardId, (account) => recordPurchase(account, input));
  }

  async grantPurchase(boardId: string, input: PurchaseGrantInput): Promise<CreditApplyResult> {
    return this.apply(boardId, (account) => grantPurchase(account, input));
  }

  async debit(boardId: string, input: DebitInput): Promise<CreditApplyResult> {
    return this.apply(boardId, (account) => debitCredits(account, input));
  }

  async refundDebit(boardId: string, input: RefundDebitInput): Promise<CreditApplyResult> {
    return this.apply(boardId, (account) => refundDebit(account, input));
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
    return this.apply(boardId, (account) => closePurchase(account, input));
  }
}
