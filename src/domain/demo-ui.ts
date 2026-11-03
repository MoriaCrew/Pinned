/**
 * Per-visitor demo boards, the client-safe bits (PIN-251). The demo
 * route answers a form post with a redirect: to the new board on
 * success, back to the landing with `?demo=<notice>` otherwise. The
 * landing shows the one-line notice and strips the flag from the
 * address bar (the `?deleted=1` pattern, board-delete-ui.ts). The
 * flag carries no slug.
 */

export const DEMO_NOTICE_PARAM = "demo";

/** "busy": a Policy.demo cap is reached; "unavailable": no template or the clone failed. */
export type DemoNotice = "busy" | "unavailable";

const NOTICES: readonly DemoNotice[] = ["busy", "unavailable"];

/** `?demo=` as a page receives it (a string, or a list when repeated); unknown values are nothing. */
export function parseDemoNotice(value: unknown): DemoNotice | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return NOTICES.find((notice) => notice === raw) ?? null;
}

/** Where the demo route sends a visitor it could not give a board. */
export function landingHrefWithDemoNotice(notice: DemoNotice): string {
  return `/?${DEMO_NOTICE_PARAM}=${notice}`;
}

/** The URL without `?demo=` (other params and the hash kept), or null when there was none. */
export function urlWithoutDemoNotice(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!url.searchParams.has(DEMO_NOTICE_PARAM)) return null;
  url.searchParams.delete(DEMO_NOTICE_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
