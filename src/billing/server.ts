import "server-only";
/** Checkout adapter selection (PIN-103). PLUS_MODE is read in src/config.ts only. */
import { getConfig } from "../config";
import type { BoardRepository } from "../domain/board-repository";
import type { PlusMode } from "../domain/plus";
import { getBoardRepository } from "../server/board-repository";
import type { Checkout } from "./checkout";
import { MockCheckout } from "./mock-checkout";
import { OffCheckout } from "./off-checkout";

export interface CheckoutDeps {
  boards: BoardRepository;
  now?: () => number;
}

/** Anything but an explicit "mock" is off: fail closed, never grant. */
export function createCheckout(mode: PlusMode, deps: CheckoutDeps): Checkout {
  return mode === "mock" ? new MockCheckout(deps) : new OffCheckout();
}

export function getCheckout(): Checkout {
  return createCheckout(getConfig().plusMode, { boards: getBoardRepository() });
}
