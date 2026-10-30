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
import type { CreditLedgerStore } from "../domain/credit-ledger";
import type { Policy } from "../policy/policy";

/** Typed pool-empty code: the photo 429 and both jobs' errorCode (PIN-151). */
export const CREDITS_POOL_EMPTY = "credits_pool_empty";

/** Debit-seam failure that is not an empty pool (ledger refused/threw). */
export const CREDIT_DEBIT_FAILED = "credit_debit_failed";

export interface CreditPoolDeps {
  /** Ledger store (PIN-148 selection); absent = fail-closed empty pool while enabled. */
  credits?: CreditLedgerStore;
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

/** One debit per ready AI scene job, however often it replays. */
export function sceneDebitEventId(jobId: string): string {
  return `debit:scene:${jobId}`;
}

/**
 * Grant Policy.credits.starterMakes exactly once per board (the
 * ledger's once-only grant under the deterministic event id).
 * Called at board creation and lazily on first credit touch for
 * boards that predate the flag. No-op while disabled, so a
 * disabled server writes nothing to the ledger, ever.
 */
export async function ensureStarterMakes(
  boardId: string,
  deps: CreditPoolDeps,
): Promise<void> {
  if (!creditsEnabled(deps.policy) || !deps.credits) return;
  await deps.credits.grantStarter(boardId, {
    eventId: starterEventId(boardId),
    amount: deps.policy.credits.starterMakes,
    at: (deps.now ?? Date.now)(),
  });
}

/**
 * Available makes for the board, ensuring the starter pool first
 * (a balance read is a credit touch). Null while credits are
 * disabled — callers then keep the exact pre-credit behaviour
 * and response shapes.
 */
export async function readAvailableMakes(
  boardId: string,
  deps: CreditPoolDeps,
): Promise<number | null> {
  if (!creditsEnabled(deps.policy)) return null;
  if (!deps.credits) return 0;
  await ensureStarterMakes(boardId, deps);
  return (await deps.credits.getBalance(boardId)).available;
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
export async function tryDebitMake(
  boardId: string,
  eventId: string,
  deps: CreditPoolDeps,
): Promise<DebitMakeResult> {
  if (!creditsEnabled(deps.policy)) return "disabled";
  if (!deps.credits) return "pool_empty";
  await ensureStarterMakes(boardId, deps);
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
