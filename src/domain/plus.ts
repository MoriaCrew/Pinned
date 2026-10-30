/**
 * Board Plus (PIN-103, docs/15-board-plus.md). Pure and
 * client-safe: entitlement shape, plan + mode ids and the skin
 * gate. The core loop is always free and guests never pay; Plus
 * is bought by the board's host and only unlocks extra skins.
 *
 * Which skins need Plus is owned by the skins catalogue
 * (`./skins`, `Skin.plus`) — this module derives from it and
 * never keeps its own list. Prices are Policy display labels
 * (Policy.plus.priceLabels), never literals here. Billing lives
 * behind the Checkout port in src/billing.
 */
import type { Board } from "./board";
import { SKINS, isPlusSkinId, type SkinId } from "./skins";

/** Skins that need Board Plus, derived from the catalogue. */
export const PLUS_SKIN_IDS: readonly SkinId[] = SKINS.filter((skin) => skin.plus).map(
  (skin) => skin.id,
);

/**
 * "board" = one-time purchase for this board; "host" = monthly
 * plan meant to cover every board the host runs (today recorded
 * per board — cross-board coverage needs a host account).
 */
export const PLUS_PLANS = ["board", "host"] as const;
export type PlusPlan = (typeof PLUS_PLANS)[number];

/** Which billing adapter runs (PLUS_MODE env, read in src/config.ts). */
export const PLUS_MODES = ["off", "mock"] as const;
export type PlusMode = (typeof PLUS_MODES)[number];

/** Where an entitlement came from: the demo mock or a real payment. */
export type PlusSource = "mock" | "stripe";

/** Stored on Board.plus once granted. */
export interface BoardPlus {
  plan: PlusPlan;
  source: PlusSource;
  grantedAt: number;
}

export interface PlusPriceLabels {
  board: string;
  host: string;
}

/** Plus membership comes from the skins catalogue only. */
export function isPlusSkin(id: unknown): boolean {
  return isPlusSkinId(id);
}

export function isPlusPlan(value: unknown): value is PlusPlan {
  return typeof value === "string" && (PLUS_PLANS as readonly string[]).includes(value);
}

export function isPlusMode(value: unknown): value is PlusMode {
  return typeof value === "string" && (PLUS_MODES as readonly string[]).includes(value);
}

/**
 * The board holds Plus that counts under `mode`. Null-safe (a
 * stored `plus: null` is a free board), and a `source: "mock"`
 * grant only counts while PLUS_MODE=mock — switching a backend to
 * off never leaves demo grants unlocking anything.
 */
export function hasPlus(board: Pick<Board, "plus">, mode: PlusMode): boolean {
  const plus = board.plus;
  if (plus == null || !isPlusPlan(plus.plan)) return false;
  return plus.source !== "mock" || mode === "mock";
}

/** Free skins always; Plus skins only with an entitlement that counts. */
export function canUseSkin(board: Pick<Board, "plus">, skinId: string, mode: PlusMode): boolean {
  return !isPlusSkin(skinId) || hasPlus(board, mode);
}

/** A held plan covers a wanted one: same plan, or host covers board. */
export function planCovers(held: PlusPlan, wanted: PlusPlan): boolean {
  return held === wanted || held === "host";
}

export function grantPlus(plan: PlusPlan, source: PlusSource, now: number): BoardPlus {
  return { plan, source, grantedAt: now };
}

export type MockGrantDecision =
  /** Write this mock entitlement. */
  | { kind: "grant"; plus: BoardPlus }
  /** The held plan already covers the request: no write. */
  | { kind: "keep" }
  /** A paid grant that does not cover the request: never replaced by a mock. */
  | { kind: "blocked" };

/**
 * The mock checkout's whole decision, applied inside the
 * repository write so concurrent requests cannot race it: a
 * covering grant is kept (host beats board in either order), a
 * paid (stripe) grant is never overwritten by a mock one, and
 * anything else gets a fresh mock grant.
 */
export function decideMockGrant(
  current: BoardPlus | null | undefined,
  plan: PlusPlan,
  now: number,
): MockGrantDecision {
  if (current != null && isPlusPlan(current.plan)) {
    if (planCovers(current.plan, plan)) return { kind: "keep" };
    if (current.source === "stripe") return { kind: "blocked" };
  }
  return { kind: "grant", plus: grantPlus(plan, "mock", now) };
}

/**
 * Public Plus readout for the board view. Carries no secret:
 * entitlement state, the billing mode (so the UI can show a
 * "not available yet" state honestly) and the Policy labels.
 * `source` and `grantedAt` stay server-side.
 */
export interface PlusView {
  active: boolean;
  plan?: PlusPlan;
  mode: PlusMode;
  priceLabels: PlusPriceLabels;
}

export function plusView(
  board: Pick<Board, "plus">,
  offer: { mode: PlusMode; priceLabels: PlusPriceLabels },
): PlusView {
  const active = hasPlus(board, offer.mode);
  return {
    active,
    ...(active && board.plus != null ? { plan: board.plus.plan } : {}),
    mode: offer.mode,
    priceLabels: { board: offer.priceLabels.board, host: offer.priceLabels.host },
  };
}
