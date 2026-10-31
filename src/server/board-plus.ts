import "server-only";
/**
 * Board Plus service (PIN-103, docs/15-board-plus.md): skin
 * change (the host, or since PIN-181 a joined member while the
 * board has Plus) and the host-only Plus checkout. Route handlers
 * run the cheap, I/O-free gates first (slug, request guards, rate
 * limit, body cap, a credential cookie present — see
 * src/app/api/boards/plus-shared.ts); these functions then load
 * the board and check, in order: the credential against the board
 * (403) -> input (400) -> entitlement inside the repository write
 * (402) -> write. An unknown board is the same 403 as a wrong
 * credential, so neither route is an existence oracle.
 *
 * BoardPlusError carries 402/403, which BoardApiError (owned by
 * the session track) does not; routes map it with the same
 * uniform-404 rule plus a machine-readable `code`.
 */
import { BoardNotFoundError, type Checkout } from "../billing/checkout";
import type { Board } from "../domain/board";
import type { BoardRepository } from "../domain/board-repository";
import { getBoardTheme, isBoardThemeId } from "../domain/board-themes";
import {
  canUseSkin,
  hasPlus,
  isPlusPlan,
  plusView,
  type PlusMode,
  type PlusPlan,
  type PlusView,
} from "../domain/plus";
import { t } from "../i18n";
import type { Policy } from "../policy/policy";
import { verifyHostToken } from "./host-session";

export class BoardPlusError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 402 | 403 | 404,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "BoardPlusError";
  }
}

export function plusRequiredError(): BoardPlusError {
  return new BoardPlusError(t("en", "plus.skinNeedsPlus"), 402, "plus_required");
}

export function hostOnlyError(): BoardPlusError {
  return new BoardPlusError(t("en", "plus.hostOnly"), 403, "host_only");
}

function notFoundError(): BoardPlusError {
  return new BoardPlusError("Board not found.", 404);
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** `{ skinId }` -> a skin id the theme registry knows, else 400. */
export function parseSkinInput(value: unknown): string {
  const skinId = field(value, "skinId");
  if (!isBoardThemeId(skinId)) {
    throw new BoardPlusError(t("en", "plus.skinUnknown"), 400, "skin_unknown");
  }
  return skinId;
}

/** `{ plan }` -> "board" | "host", else 400. */
export function parsePlusInput(value: unknown): PlusPlan {
  const plan = field(value, "plan");
  if (!isPlusPlan(plan)) {
    throw new BoardPlusError(t("en", "plus.planUnknown"), 400, "plan_unknown");
  }
  return plan;
}

export interface HostRouteDeps {
  boards: BoardRepository;
  /** The board's effective Policy (host credential age, labels). */
  policy: Policy;
  plusMode: PlusMode;
  now?: () => number;
}

/** Unknown board, no token, wrong token and expired token: one 403. */
async function requireHost(slug: string, hostToken: string | null, deps: HostRouteDeps): Promise<Board> {
  if (!hostToken) throw hostOnlyError();
  const board = await deps.boards.getBoard(slug);
  const now = deps.now?.() ?? Date.now();
  if (!board || !verifyHostToken(board, hostToken, deps.policy, now)) throw hostOnlyError();
  return board;
}

/** Who may change the look (PIN-181): the host always, a joined member while the board has Plus. */
export type SkinActor = "host" | "member";

/**
 * Decide the skin actor against the loaded board: a valid host
 * token is the host; otherwise, only while Plus counts, a joined
 * member (`isMember` resolves the board session cookie, so a
 * board without Plus never reads it). Unknown board, no
 * credential, a member without Plus: one uniform 403.
 */
export async function resolveSkinActor(
  slug: string,
  hostToken: string | null,
  isMember: () => Promise<boolean>,
  deps: HostRouteDeps,
): Promise<SkinActor> {
  const board = await deps.boards.getBoard(slug);
  if (!board) throw hostOnlyError();
  const now = deps.now?.() ?? Date.now();
  if (hostToken && verifyHostToken(board, hostToken, deps.policy, now)) return "host";
  if (hasPlus(board, deps.plusMode) && (await isMember())) return "member";
  throw hostOnlyError();
}

/**
 * PATCH skin for a decided actor. The member's Plus check, the
 * skin entitlement and the "already wearing it" no-op run inside
 * the repository write, against the board being written (a no-op
 * writes nothing, bumps nothing).
 */
export async function changeBoardSkin(
  slug: string,
  actor: SkinActor,
  rawInput: unknown,
  deps: HostRouteDeps,
): Promise<Board> {
  const skinId = parseSkinInput(rawInput);
  const theme = getBoardTheme(skinId);
  const updated = await deps.boards.updateBoardSettings(slug, (current) => {
    if (actor === "member" && !hasPlus(current, deps.plusMode)) throw hostOnlyError();
    if (!canUseSkin(current, skinId, deps.plusMode)) throw plusRequiredError();
    if (current.themeId === skinId) return null;
    return { skin: { themeId: skinId, ...(theme ? { theme: theme.tokens } : {}) } };
  });
  if (!updated) throw notFoundError();
  return updated;
}

export interface StartPlusDeps extends HostRouteDeps {
  checkout: Checkout;
}

export type StartPlusResponse =
  | { status: "granted"; plus: PlusView }
  | { status: "unavailable" }
  | { status: "redirect"; url: string };

/**
 * POST plus: host only; hands the validated plan to the Checkout
 * port. "unavailable" (PLUS_MODE=off, or a paid grant the mock
 * may not replace) is an ordinary answer the UI renders honestly,
 * not an error — and nothing is written.
 */
export async function startBoardPlus(
  slug: string,
  hostToken: string | null,
  rawInput: unknown,
  deps: StartPlusDeps,
): Promise<StartPlusResponse> {
  await requireHost(slug, hostToken, deps);
  const plan = parsePlusInput(rawInput);
  let result;
  try {
    result = await deps.checkout.startCheckout({ slug, plan });
  } catch (error) {
    if (error instanceof BoardNotFoundError) throw notFoundError();
    throw error;
  }
  switch (result.status) {
    case "granted":
      return {
        status: "granted",
        plus: plusView({ plus: result.plus }, deps.plusMode),
      };
    case "redirect":
      return { status: "redirect", url: result.url };
    case "unavailable":
      return { status: "unavailable" };
  }
}
