/**
 * Checkout port (PIN-103, docs/15-board-plus.md): the one seam
 * between Board Plus and money. Routes depend on this port only;
 * adapters are selected by PLUS_MODE in src/billing/server.ts:
 * - off  (default): always "unavailable", writes nothing.
 * - mock (demo):    grants the entitlement at once, source "mock".
 * - stripe (later): returns "redirect" to a Checkout Session; the
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
  startCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
}
