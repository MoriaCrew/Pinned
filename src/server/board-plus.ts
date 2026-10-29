import "server-only";
/**
 * Board Plus service (PIN-103, docs/15-board-plus.md): host-only
 * skin change and Plus checkout. Route handlers stay thin — slug
 * gate first (404), host cookie verified into a boolean — then
 * these functions check, in order: host (403) -> board (404) ->
 * input (400) -> entitlement (402) -> write. Every non-host gets
 * the same 403 whether or not the board exists, so neither route
 * is an existence oracle.
 *
 * BoardPlusError carries 402/403, which BoardApiError (owned by
 * the session track) does not; routes map it with the same
 * uniform-404 rule plus a machine-readable `code`.
 */
import type { Checkout } from "../billing/checkout";
import type { Board } from "../domain/board";
import type { BoardRepository } from "../domain/board-repository";
import { getBoardTheme, isBoardThemeId } from "../domain/board-themes";
import {
  canUseSkin,
  isPlusPlan,
  plusView,
  type PlusMode,
  type PlusPlan,
  type PlusView,
} from "../domain/plus";
import { t } from "../i18n";
import type { Policy } from "../policy/policy";

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

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function requireHost(isHost: boolean): void {
  if (!isHost) throw new BoardPlusError(t("en", "plus.hostOnly"), 403, "host_only");
}

async function requireBoard(boards: BoardRepository, slug: string): Promise<Board> {
  const board = await boards.getBoard(slug);
  if (!board) throw new BoardPlusError("Board not found.", 404);
  return board;
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

export interface ChangeSkinDeps {
  boards: BoardRepository;
}

/** PATCH skin: host only; Plus skins need the board's entitlement. */
export async function changeBoardSkin(
  slug: string,
  isHost: boolean,
  rawInput: unknown,
  deps: ChangeSkinDeps,
): Promise<Board> {
  requireHost(isHost);
  const board = await requireBoard(deps.boards, slug);
  const skinId = parseSkinInput(rawInput);
  if (!canUseSkin(board, skinId)) throw plusRequiredError();
  const theme = getBoardTheme(skinId);
  const updated = await deps.boards.updateBoardSettings(slug, {
    skin: { themeId: skinId, ...(theme ? { theme: theme.tokens } : {}) },
  });
  if (!updated) throw new BoardPlusError("Board not found.", 404);
  return updated;
}

export interface StartPlusDeps {
  boards: BoardRepository;
  checkout: Checkout;
  policy: Policy;
  plusMode: PlusMode;
}

export type StartPlusResponse =
  | { status: "granted"; plus: PlusView }
  | { status: "unavailable" }
  | { status: "redirect"; url: string };

/**
 * POST plus: host only; hands the validated plan to the Checkout
 * port. "unavailable" (PLUS_MODE=off) is an ordinary answer the
 * UI renders honestly, not an error — and nothing is written.
 */
export async function startBoardPlus(
  slug: string,
  isHost: boolean,
  rawInput: unknown,
  deps: StartPlusDeps,
): Promise<StartPlusResponse> {
  requireHost(isHost);
  await requireBoard(deps.boards, slug);
  const plan = parsePlusInput(rawInput);
  let result;
  try {
    result = await deps.checkout.startCheckout({ slug, plan });
  } catch (error) {
    if (error instanceof RangeError) throw new BoardPlusError("Board not found.", 404);
    throw error;
  }
  switch (result.status) {
    case "granted":
      return {
        status: "granted",
        plus: plusView(
          { plus: result.plus },
          { mode: deps.plusMode, priceLabels: deps.policy.plus.priceLabels },
        ),
      };
    case "redirect":
      return { status: "redirect", url: result.url };
    case "unavailable":
      return { status: "unavailable" };
  }
}
