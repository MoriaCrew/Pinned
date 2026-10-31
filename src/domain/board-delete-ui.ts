/**
 * Delete a board for everyone, the client side (PIN-168; the server
 * route is PIN-167). Pure and client-safe, so it is unit-testable.
 */

/** `?deleted=1` on the landing page: the "Board deleted" notice; stripped once shown, carries no slug. */
export const BOARD_DELETED_PARAM = "deleted";

/** Where the host lands: My boards when signed in, else the home page. */
export function afterBoardDeleteHref(signedIn: boolean): string {
  return `${signedIn ? "/me/boards" : "/"}?${BOARD_DELETED_PARAM}=1`;
}

/** `?deleted=` as a page receives it (a string, or a list when repeated). */
export function isBoardDeletedFlag(value: unknown): boolean {
  return (Array.isArray(value) ? value[0] : value) === "1";
}

/** The URL without `?deleted=` (other params and the hash kept), or null when there was none. */
export function urlWithoutBoardDeletedFlag(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!url.searchParams.has(BOARD_DELETED_PARAM)) return null;
  url.searchParams.delete(BOARD_DELETED_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The DELETE answer: 2xx is gone for everyone; the one 404 is "already
 * deleted, or no longer the host" (the server never says which); the
 * rest (500, the 429 brake, a dropped connection) can be tried again.
 */
export type BoardDeleteOutcome = "deleted" | "gone" | "failed";

export function boardDeleteOutcome(response: { ok: boolean; status: number } | null): BoardDeleteOutcome {
  if (!response) return "failed";
  if (response.ok) return "deleted";
  return response.status === 404 ? "gone" : "failed";
}

/** The board poll got a 404: someone deleted the board while this page was open. */
export class BoardGoneError extends Error {
  constructor() {
    super("board gone");
    this.name = "BoardGoneError";
  }
}

export const isBoardGone = (error: unknown): boolean => error instanceof BoardGoneError;

/** What a failed board poll throws: a 404 is "gone", the rest a load error. */
export const boardPollError = (status: number): Error =>
  status === 404 ? new BoardGoneError() : new Error("load failed");

/**
 * Where this page is in its own delete: nothing asked ("idle"), the
 * DELETE in flight ("pending"), or deleted and leaving for the landing
 * ("left"). The server marks the board deleted before it answers (the
 * picture sweep runs after), so a poll 404 while "pending" is our own
 * delete landing, not someone else's.
 */
export type BoardDeletePhase = "idle" | "pending" | "left";

/** The board poll runs only while no delete of ours is in flight or done. */
export const boardPollEnabled = (phase: BoardDeletePhase): boolean => phase === "idle";

/** A poll 404 swaps the page to not-found only when it can't be our own delete. */
export const showBoardGone = (phase: BoardDeletePhase, pollError: unknown): boolean =>
  phase === "idle" && isBoardGone(pollError);

type DeleteAnswer = { ok: boolean; status: number };

/**
 * The host's DELETE. Reports "pending" before the request goes out (so
 * the poll pauses first), then "left" on a 204 or back to "idle" on
 * anything else, and returns the outcome.
 */
export async function runBoardDelete(
  slug: string,
  send: (url: string, init: RequestInit) => Promise<DeleteAnswer>,
  onPhase: (phase: BoardDeletePhase) => void,
): Promise<BoardDeleteOutcome> {
  onPhase("pending");
  let response: DeleteAnswer | null = null;
  try {
    response = await send(`/api/boards/${encodeURIComponent(slug)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
  } catch {
    // Offline or dropped: the same retryable failure as a 500.
  }
  const outcome = boardDeleteOutcome(response);
  onPhase(outcome === "deleted" ? "left" : "idle");
  return outcome;
}
