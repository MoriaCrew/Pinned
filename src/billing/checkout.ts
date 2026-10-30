/**
 * Checkout port (PIN-103, docs/15-board-plus.md): the one seam
 * between Board Plus and money. Routes depend on this port only;
 * adapters are selected by PLUS_MODE in src/billing/server.ts:
 * - off  (default): always "unavailable", writes nothing.
 * - mock (demo):    grants the entitlement at once, source "mock"
 *                   ("unavailable" if a paid grant would be replaced).
 * - stripe (PIN-149): credit packs only, via the CreditCheckout
 *   port below; Plus plans stay "unavailable" (not sold yet). The
 *   webhook, not this call, writes the entitlement (docs/15).
 *
 * Callers have already checked the slug, the host cookie and the
 * plan before calling — adapters never re-authorize.
 */
import type { BoardPlus, PlusPlan } from "../domain/plus";

export interface CheckoutRequest {
  slug: string;
  plan: PlusPlan;
}

export type CheckoutResult =
  | { status: "granted"; plus: BoardPlus }
  | { status: "unavailable" }
  | { status: "redirect"; url: string };

export interface Checkout {
  /** Throws BoardNotFoundError when the board no longer exists. */
  startCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
}

/**
 * Credit-pack checkout port (PIN-149), additive next to the
 * plan-based Checkout port above: packs are not Plus plans, so
 * they get their own seam instead of overloading `plan`. The
 * service (src/server/credit-checkout.ts) owns the board,
 * creates the CheckoutIntent and records the ledger purchase;
 * an adapter here only talks to the payment provider. Nothing
 * board-identifying crosses this seam: the request carries the
 * opaque intent id and the pack offer only, and return URLs are
 * built from `returnBaseUrl` + the intent id.
 */
export interface CreditCheckoutRequest {
  /** Opaque CheckoutIntent id (also the ledger purchaseId). */
  intentId: string;
  /** Pack lookup key from Policy.credits.packs / the catalog. */
  packLookupKey: string;
  /** Pack size recorded on the intent; the webhook grants exactly this. */
  credits: number;
  /** Intent expiry (epoch ms): the provider session must not outlive it by more than the provider's minimum session life. */
  intentExpiresAt: number;
  /** Public origin the provider returns the payer to (no slug in it). */
  returnBaseUrl: string;
}

export interface CreditCheckoutSession {
  url: string;
  sessionId: string;
}

export interface CreditCheckout {
  /** Fail fast (typed errors) before an intent is created. */
  resolvePriceId(packLookupKey: string): Promise<string>;
  createCreditCheckoutSession(
    request: CreditCheckoutRequest,
  ): Promise<CreditCheckoutSession>;
}

/** Not a live credit pack in the committed catalog: a 400 for the caller. */
export class UnknownCreditPackError extends Error {
  constructor(public readonly packLookupKey: string) {
    super("Unknown credit pack.");
    this.name = "UnknownCreditPackError";
  }
}

/** The catalog sells it but the provider has no active price: server misconfiguration. */
export class CreditPriceNotFoundError extends Error {
  constructor(public readonly packLookupKey: string) {
    super("Credit pack price is not available.");
    this.name = "CreditPriceNotFoundError";
  }
}

/** The one adapter failure a route maps to its uniform 404. */
export class BoardNotFoundError extends Error {
  constructor(public readonly slug: string) {
    super("Board not found.");
    this.name = "BoardNotFoundError";
  }
}
