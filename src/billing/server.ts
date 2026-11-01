import "server-only";
/** Checkout adapter selection (PIN-103, PIN-149). PLUS_MODE and the Stripe key are read in src/config.ts only. */
import { getConfig, type AppConfig } from "../config";
import type { BoardRepository } from "../domain/board-repository";
import type { PlusMode } from "../domain/plus";
import { getBoardRepository } from "../server/board-repository";
import type { Checkout, CreditCheckout } from "./checkout";
import { MockCheckout } from "./mock-checkout";
import { OffCheckout } from "./off-checkout";
import { StripeCreditCheckout, createStripeClient } from "./stripe-checkout";
import {
  createStripeWebhookSdkClient,
  type StripeWebhookClientLike,
} from "./stripe-webhook";

export interface CheckoutDeps {
  boards: BoardRepository;
  now?: () => number;
}

/**
 * Plus-plan port selection. Anything but an explicit "mock" is
 * off - including "stripe": PIN-149 sells credit packs only (the
 * CreditCheckout port below), Plus plans are not sold through
 * Stripe yet, so the plan port keeps answering "unavailable"
 * and never grants. Fail closed, never grant.
 */
export function createCheckout(mode: PlusMode, deps: CheckoutDeps): Checkout {
  return mode === "mock" ? new MockCheckout(deps) : new OffCheckout();
}

export function getCheckout(): Checkout {
  return createCheckout(getConfig().plusMode, { boards: getBoardRepository() });
}

/**
 * Credit-pack port selection (PIN-149): a Stripe adapter only
 * when PLUS_MODE=stripe actually parsed (config already failed
 * closed to "off" without STRIPE_SECRET_KEY) and the key is
 * present; null otherwise, and the buy service answers
 * "unavailable" without writing anything.
 */
export function createCreditCheckout(
  config: AppConfig = getConfig(),
): CreditCheckout | null {
  if (config.plusMode !== "stripe" || !config.stripeSecretKey) return null;
  return new StripeCreditCheckout({
    client: createStripeClient(config.stripeSecretKey, config.stripeApiVersion),
  });
}

/**
 * Webhook client selection (PIN-150): an SDK client only when
 * PLUS_MODE=stripe actually parsed and the key is present; null
 * otherwise, and the webhook route fails closed (503) without
 * verifying or granting anything. The webhook *signing* secret
 * is checked separately by the service - it gates signature
 * verification, not SDK construction.
 */
export function createStripeWebhookClient(
  config: AppConfig = getConfig(),
): StripeWebhookClientLike | null {
  if (config.plusMode !== "stripe" || !config.stripeSecretKey) return null;
  return createStripeWebhookSdkClient(config.stripeSecretKey, config.stripeApiVersion);
}

const globalWebhookClient = globalThis as typeof globalThis & {
  __pinnedStripeWebhookClient?: StripeWebhookClientLike | null;
};

export function getStripeWebhookClient(): StripeWebhookClientLike | null {
  globalWebhookClient.__pinnedStripeWebhookClient ??= createStripeWebhookClient();
  return globalWebhookClient.__pinnedStripeWebhookClient;
}

const globalCreditCheckout = globalThis as typeof globalThis & {
  __pinnedCreditCheckout?: CreditCheckout | null;
};

/** Process-wide adapter so its in-process price cache survives requests. */
export function getCreditCheckout(): CreditCheckout | null {
  globalCreditCheckout.__pinnedCreditCheckout ??= createCreditCheckout();
  return globalCreditCheckout.__pinnedCreditCheckout;
}
