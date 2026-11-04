import "server-only";
import { cookies } from "next/headers";
import { getConfig } from "../config";
import { getPolicy } from "../policy/server";
import { getBoardRepository } from "./board-repository";
import { listMyBoards } from "./my-boards";
import { getUserRepository } from "./user-repository";
import { resolveUserSession, USER_COOKIE_NAME } from "./user-session";

/**
 * The signed-in visitor's own board slugs for the landing (PIN-264),
 * newest activity first, as My boards lists them. Null when sign-in
 * is off, there is no session cookie (no read at all for anonymous
 * visitors), the session is not valid, or anything fails: the
 * landing then shows its usual demo button. The slugs only go back
 * to their owner, in a page Next renders per request and never
 * caches.
 */
export async function viewerBoardSlugs(): Promise<string[] | null> {
  const cfg = getConfig();
  if (cfg.authMode !== "optional") return null;
  try {
    const cookieValue = (await cookies()).get(USER_COOKIE_NAME)?.value ?? null;
    if (!cookieValue) return null;
    const users = getUserRepository();
    const user = await resolveUserSession(cookieValue, { users, sessionSecret: cfg.sessionSecret, policy: getPolicy() });
    if (!user) return null;
    const cards = await listMyBoards(user, { boards: getBoardRepository(), users, plusMode: cfg.plusMode });
    return cards.map((card) => card.slug);
  } catch {
    return null;
  }
}
