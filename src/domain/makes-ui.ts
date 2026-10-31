/**
 * Makes on the board page (PIN-152, docs/15-board-plus.md):
 * pure, client-safe rules for the makes indicator, the credits
 * checkout the Plus sheet posts (PIN-182), the billing-return
 * banner and the Add sheet's free photos (PIN-231). The server owns every decision that matters (credits
 * enabled, PLUS_MODE, the webhook grant); these helpers only
 * decide what the board shows. The UI calls makes "creations":
 * an activity count for the whole board, never money held or
 * spent by a person.
 */
import { formatMoney, type Locale, type MessageKey } from "../i18n";
import { FREE_PHOTOS_USED } from "./free-photos";
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

/**
 * The label of every way into the Plus sheet from the creations UI
 * (PIN-183): "Get Plus" before the board has Plus, "Add creations"
 * once it does.
 */
export function plusActionKey(plusActive: boolean): MessageKey {
  return plusActive ? "makes.addMore" : "makes.add";
}

/**
 * What a photo or scene says when it stopped at the empty pool
 * (PIN-183). Where buying can work it is an invitation with a way
 * into the Plus sheet, never an error; with billing off it keeps the
 * plain fact and no button.
 */
export function poolEmptyCopy(
  kind: "photo" | "scene",
  { canBuy, plusActive }: { canBuy: boolean; plusActive: boolean },
): { line: MessageKey; action: MessageKey | null } {
  if (!canBuy) return { line: kind === "photo" ? "makes.poolEmptyPhoto" : "makes.poolEmptyScene", action: null };
  return { line: plusActive ? "makes.poolEmptyPlus" : "makes.poolEmpty", action: plusActionKey(plusActive) };
}

/** The PIN-230 typed 429 (the board used its free photos), as the Add sheet and the batch queue read it. */
export function isFreePhotosUsedCode(code: unknown): boolean {
  return code === FREE_PHOTOS_USED;
}

export type FreePhotosState = "ok" | "low" | "used";

/**
 * The board's free photos as the Add sheet speaks of them (PIN-231):
 * a cap people rarely feel, not a meter. `left` is the board view's
 * `credits.freePhotosLeft`; absent means the board's photos are not
 * limited (Plus, or credits off), which says nothing, like plenty
 * left. Used at 0; low at or under the Policy threshold
 * (`credits.lowFreePhotosWarning`, 0 disables the low line).
 */
export function freePhotosState(left: number | undefined, lowWarning: number): FreePhotosState {
  if (left === undefined) return "ok";
  if (left <= 0) return "used";
  if (lowWarning > 0 && left <= lowWarning) return "low";
  return "ok";
}

/**
 * What the Add sheet says once the board used its free photos
 * (PIN-231). Where buying can work it is an invitation into the Plus
 * sheet (Plus has no photo limit), never an error; with billing off it
 * keeps the plain fact and no button, like `poolEmptyCopy`. If the
 * board got Plus since (someone bought it meanwhile), the limit is
 * gone: say so, and the person tries again.
 */
export function freePhotosUsedCopy({ canBuy, plusActive }: { canBuy: boolean; plusActive: boolean }): {
  line: MessageKey;
  action: MessageKey | null;
} {
  if (plusActive) return { line: "makes.freePhotosPlusOn", action: null };
  if (!canBuy) return { line: "makes.freePhotosUsedOff", action: null };
  return { line: "makes.freePhotosUsed", action: plusActionKey(false) };
}

/** The Add sheet's pick step (PIN-231). */
export type AddPickView = { kind: "picker"; lowLeft: number | null } | { kind: "freePhotosUsed" };

/**
 * The photo picker, with the quiet "N free photos left" line when few
 * are left; or, once the board view says none are left or an upload
 * just answered `free_photos_used` (the poll may not have caught up),
 * the invitation instead of the picker, so nobody picks photos that
 * cannot be added. Plus lifts the limit, so it always brings the
 * picker back.
 */
export function addPickView({
  freePhotosLeft,
  lowWarning,
  uploadHitLimit,
  plusActive,
}: {
  freePhotosLeft: number | undefined;
  lowWarning: number;
  uploadHitLimit: boolean;
  plusActive: boolean;
}): AddPickView {
  if (plusActive) return { kind: "picker", lowLeft: null };
  const state = freePhotosState(freePhotosLeft, lowWarning);
  if (state === "used" || uploadHitLimit) return { kind: "freePhotosUsed" };
  return { kind: "picker", lowLeft: state === "low" && freePhotosLeft !== undefined ? freePhotosLeft : null };
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

/** EUR price from cents in the language's own format (Intl via formatMoney). */
export function formatEur(cents: number, locale: Locale): string {
  return formatMoney(locale, cents, "EUR");
}
