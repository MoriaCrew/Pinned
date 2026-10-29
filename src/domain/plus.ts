/**
 * Board Plus (PIN-103, docs/15-board-plus.md). Pure and
 * client-safe: entitlement shape, plan + mode ids and the skin
 * gate. The core loop is always free and guests never pay; Plus
 * is bought by the board's host and only unlocks extra skins.
 *
 * Prices are Policy display labels (Policy.plus.priceLabels),
 * never literals here. Billing lives behind the Checkout port in
 * src/billing; this module only describes what an entitlement is.
 */
import type { Board } from "./board";

/** Skins that need Board Plus. Every other skin id is free. */
export const PLUS_SKIN_IDS = ["darkroom", "postcard", "marigold"] as const;
export type PlusSkinId = (typeof PLUS_SKIN_IDS)[number];

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

export function isPlusSkin(id: unknown): id is PlusSkinId {
  return typeof id === "string" && (PLUS_SKIN_IDS as readonly string[]).includes(id);
}

export function isPlusPlan(value: unknown): value is PlusPlan {
  return typeof value === "string" && (PLUS_PLANS as readonly string[]).includes(value);
}

export function isPlusMode(value: unknown): value is PlusMode {
  return typeof value === "string" && (PLUS_MODES as readonly string[]).includes(value);
}

export function hasPlus(board: Pick<Board, "plus">): boolean {
  return board.plus !== undefined && isPlusPlan(board.plus.plan);
}

/** Free skins always; Plus skins only with the board's entitlement. */
export function canUseSkin(board: Pick<Board, "plus">, skinId: string): boolean {
  return !isPlusSkin(skinId) || hasPlus(board);
}

/** A held plan covers a wanted one: same plan, or host covers board. */
export function planCovers(held: PlusPlan, wanted: PlusPlan): boolean {
  return held === wanted || held === "host";
}

export function grantPlus(plan: PlusPlan, source: PlusSource, now: number): BoardPlus {
  return { plan, source, grantedAt: now };
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
  const active = hasPlus(board);
  return {
    active,
    ...(active && board.plus ? { plan: board.plus.plan } : {}),
    mode: offer.mode,
    priceLabels: { board: offer.priceLabels.board, host: offer.priceLabels.host },
  };
}
