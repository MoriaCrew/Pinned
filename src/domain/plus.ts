/**
 * Board Plus (PIN-103, docs/15-board-plus.md). Pure and
 * client-safe: entitlement shape, plan + mode ids and the skin
 * gate. The core loop is free and guests never have to pay.
 * Since PIN-181 Plus comes with the one credits purchase, which
 * any joined member can make for the board; it unlocks the Plus
 * skins, and lets any joined member change the look.
 *
 * Which skins need Plus is owned by the skins catalogue
 * (`./skins`, `Skin.plus`) — this module derives from it and
 * never keeps its own list. Prices live in Policy, never here.
 * Billing lives behind the ports in src/billing.
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

/** Which billing adapter runs (PLUS_MODE env, read in src/config.ts). "stripe" also needs a secret key there; without one config fails closed to "off". */
export const PLUS_MODES = ["off", "mock", "stripe"] as const;
export type PlusMode = (typeof PLUS_MODES)[number];

/** Where an entitlement came from: the demo mock or a real payment. */
export type PlusSource = "mock" | "stripe";

/** Why a paid entitlement was taken back (PIN-242). */
export type PlusRevocationReason = "full_refund" | "dispute_lost";

/**
 * Tombstone left by a revocation (PIN-242), stored on
 * `Board.plusRevocation` (server-only, never in a view): the grant
 * that was removed, so a dispute that is later won or reinstated
 * can restore exactly it — and nothing else can.
 */
export interface BoardPlusRevocation {
  purchaseId: string;
  reason: PlusRevocationReason;
  /** The dispute whose loss revoked the grant; only for `dispute_lost`. */
  disputeId?: string;
  revokedPlus: BoardPlus;
  revokedAt: number;
}

/** Stored on Board.plus once granted. */
export interface BoardPlus {
  plan: PlusPlan;
  source: PlusSource;
  grantedAt: number;
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
 * The paid-purchase grant (PIN-181), run inside the repository
 * write by the Stripe webhook: null (no write) when the board
 * already holds a stripe grant of any plan, so a paid host plan
 * is never downgraded and a replay writes nothing; otherwise a
 * paid `board` grant, which also replaces a demo mock grant.
 */
export function decidePurchasePlusGrant(
  board: Pick<Board, "plus">,
  at: number,
): { plus: BoardPlus } | null {
  const current = board.plus;
  if (current != null && isPlusPlan(current.plan) && current.source === "stripe") return null;
  return { plus: grantPlus("board", "stripe", at) };
}

/**
 * Public Plus readout for the board view. Carries no secret:
 * entitlement state and the billing mode (so the UI can pick
 * the buy path and show a "not available yet" state honestly).
 * The price is never here: the UI formats it from the Policy
 * pack's `eurCents`. `source` and `grantedAt` stay server-side.
 */
export interface PlusView {
  active: boolean;
  plan?: PlusPlan;
  mode: PlusMode;
}

export interface PlusRevocationInput {
  purchaseId: string;
  reason: PlusRevocationReason;
  disputeId?: string;
  at: number;
  hasOtherLiveGrant: boolean;
}

/**
 * The revocation decision (PIN-242), run inside the repository
 * write by the Stripe webhook on a cumulative full refund or a
 * dispute closed lost. `hasOtherLiveGrant` comes from the caller
 * (the credit ledger: another granted purchase not fully clawed
 * back); Plus then stays. A mock grant is never touched by a
 * Stripe event, and a replay after the revoke writes nothing.
 */
export function decidePlusRevocation(
  board: Pick<Board, "plus">,
  input: PlusRevocationInput,
): { plus: null; plusRevocation: BoardPlusRevocation } | null {
  if (input.hasOtherLiveGrant) return null;
  const current = board.plus;
  // A credits purchase only ever grants the board plan, so only
  // that stripe grant is its to take back (never a host plan).
  if (current == null || current.plan !== "board" || current.source !== "stripe") return null;
  return {
    plus: null,
    plusRevocation: {
      purchaseId: input.purchaseId,
      reason: input.reason,
      ...(input.disputeId ? { disputeId: input.disputeId } : {}),
      revokedPlus: { ...current },
      revokedAt: input.at,
    },
  };
}

/**
 * The dispute-win restore (PIN-242), mirroring the makes
 * freeze/restore symmetry: only the very dispute whose loss
 * revoked the grant brings it back. A grant written since (a new
 * purchase) is never overwritten - the tombstone just clears.
 */
export function decidePlusRestore(
  board: Pick<Board, "plus" | "plusRevocation">,
  disputeId: string,
): { plus: BoardPlus; plusRevocation: null } | { plusRevocation: null } | null {
  const revocation = board.plusRevocation;
  if (revocation == null || revocation.reason !== "dispute_lost") return null;
  if (revocation.disputeId !== disputeId) return null;
  if (board.plus != null) return { plusRevocation: null };
  return { plus: { ...revocation.revokedPlus }, plusRevocation: null };
}

export function plusView(board: Pick<Board, "plus">, mode: PlusMode): PlusView {
  const active = hasPlus(board, mode);
  return {
    active,
    ...(active && board.plus != null ? { plan: board.plus.plan } : {}),
    mode,
  };
}
