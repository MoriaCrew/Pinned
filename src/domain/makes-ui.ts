/**
 * Makes on the board page (PIN-152, docs/15-board-plus.md):
 * pure, client-safe rules for the makes indicator, the credits
 * checkout the Plus sheet posts (PIN-182) and the billing-return
 * banner. The server owns every decision that matters (credits
 * enabled, PLUS_MODE, the webhook grant); these helpers only
 * decide what the board shows. The UI calls makes "creations":
 * an activity count for the whole board, never money held or
 * spent by a person.
 */
import type { Locale } from "../i18n";
import { safeRedirectUrl } from "./plus-ui";

/** The PIN-151 typed pool-empty code (photo 429 + both jobs' errorCode), mirrored client-side. */
export const CREDITS_POOL_EMPTY_CODE = "credits_pool_empty";

export function isPoolEmptyCode(code: unknown): boolean {
  return code === CREDITS_POOL_EMPTY_CODE;
}

/** One purchasable pack as Policy.credits.packs offers it (display + offer data). */
export interface MakesPack {
  lookupKey: string;
  credits: number;
  eurCents: number;
  label: string;
}

export type MakesState = "ok" | "low" | "empty";

/** Empty at zero; low at or under the Policy threshold (0 disables the low state). */
export function makesState(availableMakes: number, lowMakesWarning: number): MakesState {
  if (availableMakes <= 0) return "empty";
  if (lowMakesWarning > 0 && availableMakes <= lowMakesWarning) return "low";
  return "ok";
}

/** The flags `/billing/return` lands with (PIN-149), plus a defensive "failed". */
export type BillingFlag = "processing" | "cancelled" | "failed";

export function parseBillingFlag(value: unknown): BillingFlag | null {
  return value === "processing" || value === "cancelled" || value === "failed" ? value : null;
}

/** The URL without `?billing=` (other params and the hash kept), or null when there was none. */
export function urlWithoutBilling(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!url.searchParams.has("billing")) return null;
  url.searchParams.delete("billing");
  return `${url.pathname}${url.search}${url.hash}`;
}

export type BillingBannerKind = "processing" | "added" | "cancelled" | "failed" | "checkLater";

/**
 * What the return banner says. Granting is webhook-only
 * (PIN-150), so "processing" only becomes "added" once the
 * board view's count is actually higher than the baseline
 * captured before checkout — the redirect alone proves
 * nothing. Refetches spent with no rise lands on a neutral
 * "check later", never a claim either way.
 */
export function billingBannerKind({
  flag,
  baseline,
  current,
  exhausted,
}: {
  flag: BillingFlag | null;
  baseline: number | null;
  current: number | null;
  exhausted: boolean;
}): BillingBannerKind | null {
  if (flag === null) return null;
  if (flag === "cancelled") return "cancelled";
  if (flag === "failed") return "failed";
  if (baseline !== null && current !== null && current > baseline) return "added";
  return exhausted ? "checkLater" : "processing";
}

/** POST body for the PIN-149 credits checkout route. */
export function creditCheckoutBody(lookupKey: string): { lookupKey: string } {
  return { lookupKey };
}

export type CreditCheckoutErrorKind = "cap" | "rate" | "join" | "generic";

/** POST credits/checkout answer, as the Plus sheet acts on it. */
export type CreditCheckoutResult =
  | { kind: "redirect"; url: string }
  | { kind: "unavailable" }
  | { kind: "error"; error: CreditCheckoutErrorKind };

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

export function readCreditCheckoutResponse(status: number, body: unknown): CreditCheckoutResult {
  if (status >= 200 && status < 300) {
    if (field(body, "status") === "unavailable") return { kind: "unavailable" };
    if (field(body, "status") === "redirect") {
      const url = safeRedirectUrl(field(body, "url"));
      return url ? { kind: "redirect", url } : { kind: "error", error: "generic" };
    }
    return { kind: "error", error: "generic" };
  }
  const code = field(body, "code");
  if (status === 503 && code === "checkout_unavailable") return { kind: "unavailable" };
  if (status === 429) return { kind: "error", error: code === "intent_cap_reached" ? "cap" : "rate" };
  if (status === 401) return { kind: "error", error: "join" };
  return { kind: "error", error: "generic" };
}

/** EUR price from cents: "€4.99" (en) / "4,99 €" (fr). Deterministic, no ICU variance. */
export function formatEur(cents: number, locale: Locale): string {
  const euros = Math.floor(cents / 100);
  const rest = String(Math.abs(cents % 100)).padStart(2, "0");
  return locale === "fr" ? `${euros},${rest} €` : `€${euros}.${rest}`;
}
