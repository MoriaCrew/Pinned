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
