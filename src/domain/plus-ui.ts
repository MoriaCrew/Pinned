/**
 * Board Plus on the board page (PIN-111, docs/15-board-plus.md):
 * pure, client-safe rules for "Change look", the Plus try-on and
 * "Keep it". The server owns every decision that matters (host
 * check, entitlement, mode); these helpers only decide what the
 * host sees and which request to send next.
 *
 * - Only the board's host changes the look. Guests never see the
 *   controls and never get a try-on, even from a `?tryon=` link.
 * - A free skin (or any skin once Plus counts) applies at once.
 * - A Plus skin without Plus is tried on locally: nothing changes
 *   for anyone else until it is kept, and keeping it asks for Plus.
 */
import type { PlusPlan, PlusView } from "./plus";
import { getSkin, isPlusSkinId, isSkinId, type SkinId } from "./skins";

/** The Plus fields of the board view the page reads (all optional on old payloads). */
export type PlusState = Pick<PlusView, "active" | "mode">;

/** The try-on that really shows: host only, and never the skin the board already wears. */
export function activeTryOn(boardSkin: SkinId, tryOnSkin: SkinId | null, isHost: boolean): SkinId | null {
  if (!isHost || tryOnSkin === null || tryOnSkin === boardSkin) return null;
  return tryOnSkin;
}

/** The skin the board root renders: the host's try-on, else the board's own skin. */
export function effectiveSkin(boardSkin: SkinId, tryOnSkin: SkinId | null, isHost: boolean): SkinId {
  return activeTryOn(boardSkin, tryOnSkin, isHost) ?? boardSkin;
}

/** Free skins always; Plus skins only while the board's Plus counts. */
export function canApplyDirectly(skin: SkinId, plus: Pick<PlusState, "active"> | null | undefined): boolean {
  return !getSkin(skin).plus || Boolean(plus?.active);
}

/**
 * `?tryon=<skin>` (the start flow sends a host here after picking a
 * Plus look for a new board): a Plus skin the board is not wearing,
 * for the host only. Anything else (guests, free skins, junk,
 * repeated params) is ignored.
 */
export function parseTryOn(query: unknown, isHost: boolean, boardSkin: SkinId): SkinId | null {
  if (!isHost || !isSkinId(query) || !isPlusSkinId(query) || query === boardSkin) return null;
  return query;
}

/** What choosing a look in the Change look sheet does. */
export type LookChoice =
  /** Already showing: nothing to do. */
  | { kind: "none" }
  /** Back to the board's own skin: end the try-on. */
  | { kind: "restore" }
  /** Save it now (PATCH skin), shown at once. */
  | { kind: "apply"; skin: SkinId }
  /** Plus skin without Plus: wear it locally first. */
  | { kind: "tryOn"; skin: SkinId };

export function chooseLook(
  skin: SkinId,
  current: { boardSkin: SkinId; tryOn: SkinId | null; plus: Pick<PlusState, "active"> | null | undefined },
): LookChoice {
  const shown = current.tryOn ?? current.boardSkin;
  if (skin === shown) return { kind: "none" };
  if (skin === current.boardSkin) return { kind: "restore" };
  if (canApplyDirectly(skin, current.plus)) return { kind: "apply", skin };
  return { kind: "tryOn", skin };
}

/** "Keep it" on a try-on: save it when Plus counts, else offer Plus. */
export function keepStep(skin: SkinId, plus: Pick<PlusState, "active"> | null | undefined): "apply" | "offer" {
  return canApplyDirectly(skin, plus) ? "apply" : "offer";
}

/** Plus can be bought here (mode "off" shows the plans as Coming soon). */
export function canBuyPlus(plus: Pick<PlusState, "mode"> | null | undefined): boolean {
  return plus?.mode !== undefined && plus.mode !== "off";
}

/**
 * The pin that wears foil: the board's first pinned thing, only
 * while Plus counts (docs/14: keep foil rare). Cards come oldest
 * first (pinCards).
 */
export function foilPinId(
  cards: readonly { pinId: string; status: string }[],
  plus: Pick<PlusState, "active"> | null | undefined,
): string | null {
  if (!plus?.active) return null;
  return cards.find((card) => card.status === "pinned")?.pinId ?? null;
}

/**
 * Cut-out URLs of the board's pinned things, oldest first, for the
 * skin picker's mini boards (the picker shows as many as it has
 * room for). Candidates stay private to their uploader, so never.
 */
export function lookSample(cards: readonly { status: string; element: { imageUrl: string } }[]): string[] {
  return cards.filter((card) => card.status === "pinned").map((card) => card.element.imageUrl);
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** PATCH /skin answer, as the page acts on it. */
export type SkinResult = { kind: "applied"; themeId: string | null } | { kind: "plusRequired" } | { kind: "failed" };

export function readSkinResponse(status: number, body: unknown): SkinResult {
  if (status === 402 && field(body, "code") === "plus_required") return { kind: "plusRequired" };
  const board = field(body, "board");
  if (status >= 200 && status < 300 && board !== undefined) {
    const themeId = field(board, "themeId");
    return { kind: "applied", themeId: typeof themeId === "string" ? themeId : null };
  }
  return { kind: "failed" };
}

/** A checkout redirect the page may follow: https only (or a same-origin path). */
export function safeRedirectUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  if (url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\")) return url;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isPlusViewLike(value: unknown): value is PlusView {
  return typeof field(value, "active") === "boolean" && typeof field(value, "mode") === "string";
}

/** POST /plus answer, as the page acts on it. */
export type CheckoutResult =
  | { kind: "granted"; plus: PlusView | null }
  | { kind: "unavailable" }
  | { kind: "redirect"; url: string }
  | { kind: "failed" };

export function readCheckoutResponse(status: number, body: unknown): CheckoutResult {
  if (status < 200 || status >= 300) return { kind: "failed" };
  switch (field(body, "status")) {
    case "granted": {
      const plus = field(body, "plus");
      return { kind: "granted", plus: isPlusViewLike(plus) ? plus : null };
    }
    case "unavailable":
      return { kind: "unavailable" };
    case "redirect": {
      const url = safeRedirectUrl(field(body, "url"));
      return url ? { kind: "redirect", url } : { kind: "failed" };
    }
    default:
      return { kind: "failed" };
  }
}

/** The URL without `?tryon=` (other params and the hash kept), or null when there was none. */
export function urlWithoutTryOn(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!url.searchParams.has("tryon")) return null;
  url.searchParams.delete("tryon");
  return `${url.pathname}${url.search}${url.hash}`;
}

// ---------- The flow ----------

/** One line under the flow: a confirmation that fades, or an error that stays until dismissed. */
export type LookNotice =
  | { kind: "applied"; skin: SkinId }
  | { kind: "granted"; skin: SkinId }
  | { kind: "lookFailed" }
  /** Plus landed but saving the look failed: say both, so Keep it is a plain retry. */
  | { kind: "grantedLookFailed" }
  | { kind: "plusFailed" };

export interface LookFlowState {
  sheet: "none" | "look" | "plus";
  /** Plus skin the host wears locally (nothing saved). */
  tryOn: SkinId | null;
  /** Skin shown while its PATCH runs (optimistic); null when none. */
  applying: SkinId | null;
  plan: PlusPlan;
  /** POST /plus in flight. */
  checkingOut: boolean;
  /** Checkout said "unavailable": the Plus sheet shows Coming soon. */
  unavailable: boolean;
  /** Plus was just granted: the next applied look says so. */
  grantedNow: boolean;
  notice: LookNotice | null;
}

export const initialLookFlow: LookFlowState = {
  sheet: "none",
  tryOn: null,
  applying: null,
  plan: "board",
  checkingOut: false,
  unavailable: false,
  grantedNow: false,
  notice: null,
};

export type LookFlowEvent =
  | { type: "openLook" }
  | { type: "closeSheet" }
  | { type: "tryOn"; skin: SkinId }
  | { type: "endTryOn" }
  | { type: "offerPlus" }
  | { type: "choosePlan"; plan: PlusPlan }
  | { type: "applyStart"; skin: SkinId }
  | { type: "applyDone"; skin: SkinId }
  | { type: "applyFailed" }
  /** PATCH said 402: keep wearing the skin locally and offer Plus. */
  | { type: "plusRequired"; skin: SkinId }
  | { type: "checkoutStart" }
  | { type: "checkoutGranted" }
  | { type: "checkoutUnavailable" }
  | { type: "checkoutFailed" }
  | { type: "dismissNotice" };

export function lookFlow(state: LookFlowState, event: LookFlowEvent): LookFlowState {
  switch (event.type) {
    case "openLook":
      return { ...state, sheet: "look", notice: null };
    case "closeSheet":
      // The try-on stays: closing the Plus sheet means "keep trying".
      return state.checkingOut ? state : { ...state, sheet: "none" };
    case "tryOn":
      return { ...state, sheet: "none", tryOn: event.skin, notice: null };
    case "endTryOn":
      return { ...state, tryOn: null, sheet: state.sheet === "plus" ? "none" : state.sheet };
    case "offerPlus":
      return { ...state, sheet: "plus", unavailable: false, notice: null };
    case "choosePlan":
      return { ...state, plan: event.plan };
    case "applyStart":
      return { ...state, sheet: "none", applying: event.skin, notice: null };
    case "applyDone":
      return {
        ...state,
        applying: null,
        tryOn: null,
        grantedNow: false,
        notice: { kind: state.grantedNow ? "granted" : "applied", skin: event.skin },
      };
    case "applyFailed":
      return {
        ...state,
        applying: null,
        grantedNow: false,
        notice: { kind: state.grantedNow ? "grantedLookFailed" : "lookFailed" },
      };
    case "plusRequired":
      return {
        ...state,
        applying: null,
        tryOn: event.skin,
        grantedNow: false,
        sheet: "plus",
        unavailable: false,
        notice: null,
      };
    case "checkoutStart":
      return { ...state, checkingOut: true, notice: null };
    case "checkoutGranted":
      return { ...state, checkingOut: false, grantedNow: true };
    case "checkoutUnavailable":
      return { ...state, checkingOut: false, unavailable: true };
    case "checkoutFailed":
      return { ...state, checkingOut: false, sheet: "none", notice: { kind: "plusFailed" } };
    case "dismissNotice":
      return { ...state, notice: null };
  }
}
