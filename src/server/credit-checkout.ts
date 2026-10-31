import "server-only";
/**
 * Credit-pack buy service + billing return resolver (PIN-149,
 * docs/15-board-plus.md). The route runs the cheap gates and
 * proves a board participant/host session; this service then:
 * validates the pack against Policy.credits, resolves the Stripe
 * price (fail fast, before anything is written), creates the
 * opaque CheckoutIntent (per-board pending cap lives in the
 * store), records the ledger purchase, and only then asks the
 * CreditCheckout adapter for a hosted session. The board slug
 * is used as the server-internal board id for the stores and
 * never crosses to the adapter - Stripe sees the intent id.
 *
 * Grants are webhook-only (PIN-150): neither a successful
 * session creation nor the /billing/return redirect below
 * credits anything. The return resolver maps an intent id back
 * to its board server-side; unknown and expired intents get one
 * identical generic answer. It is read-only (PIN-178): it never
 * expires or closes an intent, so a payer's redirect cannot race
 * the webhook's grant.
 */
import {
  CreditPriceNotFoundError,
  UnknownCreditPackError,
  type CreditCheckout,
} from "../billing/checkout";
import type { BoardRepository } from "../domain/board-repository";
import type { CreditLedgerStore } from "../domain/credit-ledger";
import type { PlusMode } from "../domain/plus";
import type { Policy, PolicyCreditPack } from "../policy/policy";
import type { CheckoutIntentStore } from "./checkout-intent";

export class CreditCheckoutError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 429 | 503,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "CreditCheckoutError";
  }
}

function packUnknownError(): CreditCheckoutError {
  return new CreditCheckoutError("That makes pack is not available.", 400, "pack_unknown");
}

function checkoutUnavailableError(): CreditCheckoutError {
  return new CreditCheckoutError(
    "Checkout is not available right now. Please try again.",
    503,
    "checkout_unavailable",
  );
}

/** Store cap errors name the board internally; the caller gets this slug-free shape instead. */
function intentCapError(): CreditCheckoutError {
  return new CreditCheckoutError(
    "Too many checkouts are already open for this board. Finish or wait for one to expire, then try again.",
    429,
    "intent_cap_reached",
  );
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** `{ lookupKey }` -> a pack Policy offers, else 400 pack_unknown. */
export function parseCreditPackInput(value: unknown, policy: Policy): PolicyCreditPack {
  const lookupKey = field(value, "lookupKey");
  const pack =
    typeof lookupKey === "string"
      ? policy.credits.packs.find((candidate) => candidate.lookupKey === lookupKey)
      : undefined;
  if (!pack) throw packUnknownError();
  return pack;
}

function isIntentCapError(error: unknown): boolean {
  return (
    error instanceof RangeError &&
    /already holds \d+ pending checkout intents/.test(error.message)
  );
}

export interface BuyCreditsDeps {
  boards: BoardRepository;
  /** The board's effective Policy (packs, cap, TTL). */
  policy: Policy;
  plusMode: PlusMode;
  intents: CheckoutIntentStore;
  ledger: CreditLedgerStore;
  /** Null unless PLUS_MODE=stripe with a key (src/billing/server.ts). */
  creditCheckout: CreditCheckout | null;
  /** Public origin for the Stripe return URLs (never contains the slug). */
  returnBaseUrl: string;
  now?: () => number;
}

export type BuyCreditsResponse =
  | { status: "redirect"; url: string }
  | { status: "unavailable" };

/**
 * Buy one pack for this board. "unavailable" (any non-stripe
 * mode) mirrors the Plus route: an ordinary answer, nothing
 * written, no Stripe call. Pack validation runs first, also
 * mirroring the Plus route's bad-plan 400.
 */
export async function buyCredits(
  slug: string,
  rawInput: unknown,
  deps: BuyCreditsDeps,
): Promise<BuyCreditsResponse> {
  const board = await deps.boards.getBoard(slug);
  if (!board) throw new CreditCheckoutError("Board not found.", 404);
  const pack = parseCreditPackInput(rawInput, deps.policy);
  if (deps.plusMode !== "stripe" || !deps.creditCheckout) {
    return { status: "unavailable" };
  }
  const checkout = deps.creditCheckout;
  const now = deps.now?.() ?? Date.now();

  // Resolve the price before writing anything: an unknown pack
  // or a missing Stripe price must not leave an intent behind.
  try {
    await checkout.resolvePriceId(pack.lookupKey);
  } catch (error) {
    if (error instanceof UnknownCreditPackError) throw packUnknownError();
    if (error instanceof CreditPriceNotFoundError) throw checkoutUnavailableError();
    throw error;
  }

  let intent;
  try {
    intent = await deps.intents.create({
      boardId: slug,
      packLookupKey: pack.lookupKey,
      credits: pack.credits,
      eurCents: pack.eurCents,
      at: now,
      intentTtlSeconds: deps.policy.credits.intentTtlSeconds,
      pendingIntentCapPerBoard: deps.policy.credits.pendingIntentCapPerBoard,
    });
  } catch (error) {
    if (isIntentCapError(error)) throw intentCapError();
    throw error;
  }

  try {
    await deps.ledger.recordPurchase(slug, {
      purchaseId: intent.purchaseId,
      credits: intent.credits,
    });
    const session = await checkout.createCreditCheckoutSession({
      intentId: intent.id,
      packLookupKey: pack.lookupKey,
      credits: pack.credits,
      intentExpiresAt: intent.expiresAt,
      returnBaseUrl: deps.returnBaseUrl,
    });
    return { status: "redirect", url: session.url };
  } catch (error) {
    // The payer never got a session: close the intent and its
    // ledger purchase so neither squats on the board's cap.
    await deps.intents
      .close(intent.id, deps.now?.() ?? Date.now())
      .catch(() => undefined);
    await deps.ledger
      .closePurchase(slug, { purchaseId: intent.purchaseId })
      .catch(() => undefined);
    if (error instanceof UnknownCreditPackError) throw packUnknownError();
    if (error instanceof CreditPriceNotFoundError) throw checkoutUnavailableError();
    throw checkoutUnavailableError();
  }
}

export interface BillingReturnDeps {
  /** Read-only on purpose (PIN-178): the return path never writes. */
  intents: Pick<CheckoutIntentStore, "get">;
  now?: () => number;
}

export type BillingReturn =
  /** Absolute path back to the board with a result flag (never a grant). */
  | { kind: "board"; location: string }
  /** One identical answer for unknown, expired and malformed intents. */
  | { kind: "generic"; location: string };

const GENERIC_RETURN: BillingReturn = { kind: "generic", location: "/" };

/**
 * Resolve a /billing/return hit. A known intent (pending and
 * unexpired, or already closed by the webhook) goes back to its
 * board: "processing" after a completed payment - the webhook
 * grants, this redirect never does - and "cancelled" after a
 * bail-out. Expired intents (marked or past their TTL) answer
 * exactly like unknown ones, and nothing is written here.
 */
export async function resolveBillingReturn(
  intentId: string | null,
  result: string | null,
  deps: BillingReturnDeps,
): Promise<BillingReturn> {
  if (!intentId || intentId.length > 200 || !intentId.trim()) return GENERIC_RETURN;
  const now = deps.now?.() ?? Date.now();
  const intent = await deps.intents.get(intentId).catch(() => null);
  if (!intent || intent.status === "expired") return GENERIC_RETURN;
  if (intent.status === "pending" && now >= intent.expiresAt) return GENERIC_RETURN;
  const flag = result === "cancel" ? "cancelled" : "processing";
  return { kind: "board", location: `/g/${intent.boardId}?billing=${flag}` };
}
