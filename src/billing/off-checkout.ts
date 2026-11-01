import "server-only";
/** PLUS_MODE=off (default): Plus cannot be bought; nothing is written. */
import type { Checkout, CheckoutRequest, CheckoutResult } from "./checkout";

export class OffCheckout implements Checkout {
  async startCheckout(_request: CheckoutRequest): Promise<CheckoutResult> {
    return { status: "unavailable" };
  }
}
