import "server-only";
/**
 * Board makes pool wiring (PIN-151, docs/15-board-plus.md): the
 * one place the board loop touches the credit ledger. Everything
 * here is gated on Policy.credits.enabled — while the flag is off
 * (the shipped default) no ledger method is ever called, so the
 * pre-credit behaviour is byte-identical. Turning the flag off
 * mid-life returns to that behaviour at once; turning it on makes
 * the next credit touch (board create, board-view balance read,
 * photo preflight, scene run) grant the starter pool first.
 *
 * A "make" is one successful AI production, debited exactly 1:
 * one completed DecomposeJob per photo (any number of elements
 * or later tap-adds), or one ready AI scene/remix. Collages,
 * failures, refusals, cap denies and riders (chips, tap naming
 * and adds, dictation) never debit. Event ids are deterministic
 * per board (starter) and per job (debit), so replays and
 * retries can never double-grant or double-debit.
 *
 * Enabled-but-unwired (no store in deps) reads as an empty pool
 * and refuses debits: failing closed beats gifting free makes.
 */
import type { BoardRepository } from "../domain/board-repository";
import type { CreditBalanceView, CreditLedgerStore } from "../domain/credit-ledger";
import type { Policy } from "../policy/policy";

/** Typed pool-empty code: the photo 429 and both jobs' errorCode (PIN-151). */
export const CREDITS_POOL_EMPTY = "credits_pool_empty";

/** Debit-seam failure that is not an empty pool (ledger refused/threw). */
export const CREDIT_DEBIT_FAILED = "credit_debit_failed";

export interface CreditPoolDeps {
  /** Ledger store (PIN-148 selection); absent = fail-closed empty pool while enabled. */
  credits?: CreditLedgerStore;
  /** Board reads for the lazy starter grant (PIN-205): it grants the amount the board stored at creation. */
  boards?: Pick<BoardRepository, "getBoard">;
  policy: Policy;
  now?: () => number;
}

export function creditsEnabled(policy: Policy): boolean {
  return policy.credits.enabled;
}

/** Once-per-board starter event id: every ensure replays the same id. */
export function starterEventId(boardId: string): string {
  return `starter:${boardId}`;
}

/** One debit per completed photo job, however often it replays. */
export function photoDebitEventId(jobId: string): string {
  return `debit:photo:${jobId}`;
}

/** Refund event for a photo debit (below); the scene debit id follows. */
/** Refund of a photo debit whose result could not be exposed (one per job). */
export function photoRefundEventId(jobId: string): string {
  return `refund:photo:${jobId}`;
}

/** One debit per ready AI scene job, however often it replays. */
export function sceneDebitEventId(jobId: string): string {
  return `debit:scene:${jobId}`;
}

/**
 * Grant the starter pool exactly once per board (the ledger's
 * once-only grant under the deterministic event id). Board
 * creation passes the amount it decided for the maker (PIN-205);
 * later touches reach this only when the head read shows no
 * starter yet, and then grant what the board stored, falling back
 * to Policy.credits.starterMakes for boards made before the rule.
 * No-op while disabled, so a disabled server writes nothing to
 * the ledger, ever.
 */
export async function ensureStarterMakes(
  boardId: string,
  deps: CreditPoolDeps,
  amount?: number,
): Promise<void> {
  if (!creditsEnabled(deps.policy) || !deps.credits) return;
  await deps.credits.grantStarter(boardId, {
    eventId: starterEventId(boardId),
    amount: amount ?? (await storedStarterMakes(boardId, deps)),
    at: (deps.now ?? Date.now)(),
  });
}

/** The free pool a board was given at creation, or the Policy default when it stored none. */
async function storedStarterMakes(boardId: string, deps: CreditPoolDeps): Promise<number> {
  const board = deps.boards ? await deps.boards.getBoard(boardId) : null;
  return board?.starterMakes ?? deps.policy.credits.starterMakes;
}

/**
 * The cheap credit touch (PIN-179): read the account head, and
 * only when it is missing or its starter has not landed run the
 * transactional once-only grant, then re-read. A board whose
 * starter is granted costs one head read per touch — no ledger
 * transaction, no purchases/entries read — however often the
 * board page polls. Concurrent first touches may each call the
 * grant; its deterministic event id keeps it exactly once.
 */
async function balanceWithStarter(
  boardId: string,
  credits: CreditLedgerStore,
  deps: CreditPoolDeps,
): Promise<CreditBalanceView> {
  const head = await credits.getBalance(boardId);
  if (head.starterGranted) return head;
  await ensureStarterMakes(boardId, deps);
  return credits.getBalance(boardId);
}

/**
 * Available makes for the board, ensuring the starter pool first
 * (a balance read is a credit touch) through the cheap head read
 * above. Null while credits are disabled — callers then keep the
 * exact pre-credit behaviour and response shapes, with no ledger
 * call at all.
 */
export async function readAvailableMakes(
  boardId: string,
  deps: CreditPoolDeps,
): Promise<number | null> {
  if (!creditsEnabled(deps.policy)) return null;
  if (!deps.credits) return 0;
  return (await balanceWithStarter(boardId, deps.credits, deps)).available;
}

export type DebitMakeResult = "debited" | "pool_empty" | "disabled";

/** The ledger's insufficient-funds refusal, matched like the intent-cap error in credit-checkout. */
function isInsufficientMakes(error: unknown): boolean {
  return error instanceof RangeError && /exceeds available/.test(error.message);
}

/**
 * Spend exactly 1 make under a deterministic per-job event id.
 * "pool_empty" means the atomic debit lost (or the pool was
 * already empty): the caller must not expose its AI result.
 * A replay of an already-applied event id reports "debited"
 * (the make was paid for). Any other ledger failure throws, so
 * callers can fail closed without claiming the pool was empty.
 */
export type RefundMakeResult = "refunded" | "disabled";

/**
 * Give back the 1 make spent under `debitEventId`, under the
 * deterministic refund event id. Idempotent by event id and per
 * debit (ledger rules), so a runner retrying its guarded finish can
 * never double-refund. Disabled = no ledger call, exactly like the
 * debit. Enabled-but-unwired throws (fail closed): the debit could
 * not have landed without a store either.
 */
export async function tryRefundMake(
  boardId: string,
  refundEventId: string,
  debitEventId: string,
  deps: CreditPoolDeps,
): Promise<RefundMakeResult> {
  if (!creditsEnabled(deps.policy)) return "disabled";
  if (!deps.credits) {
    throw new RangeError("Credits enabled without a ledger store; cannot refund a make.");
  }
  await deps.credits.refundDebit(boardId, {
    eventId: refundEventId,
    debitEventId,
    at: (deps.now ?? Date.now)(),
  });
  return "refunded";
}

export async function tryDebitMake(
  boardId: string,
  eventId: string,
  deps: CreditPoolDeps,
): Promise<DebitMakeResult> {
  if (!creditsEnabled(deps.policy)) return "disabled";
  if (!deps.credits) return "pool_empty";
  // Same cheap touch: only a never-granted head costs a starter
  // transaction before the debit's own.
  await balanceWithStarter(boardId, deps.credits, deps);
  try {
    await deps.credits.debit(boardId, {
      eventId,
      amount: 1,
      at: (deps.now ?? Date.now)(),
    });
    return "debited";
  } catch (error) {
    if (isInsufficientMakes(error)) return "pool_empty";
    throw error;
  }
}
