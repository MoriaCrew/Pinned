import type { NextResponse } from "next/server";
import { getConfig } from "../../config";
import type { UserProfile } from "../../domain/user";
import { getPolicy } from "../../policy/server";
import { readCookieValue } from "../../server/board-session";
import { getBoardRepository } from "../../server/board-repository";
import { getTokenVerifier } from "../../server/token-verifier";
import { getUserRepository } from "../../server/user-repository";
import {
  resolveUserSession,
  resolveUserSessionContext,
  USER_COOKIE_NAME,
  type ClaimDeps,
  type EstablishUserSessionDeps,
  type UserSessionContext,
  type UserSessionDeps,
} from "../../server/user-session";
import { notFound } from "./boards/shared";

/**
 * AUTH_MODE gate (PIN-83): called FIRST in every sign-in route.
 * In the default link-only mode the route does not exist — the
 * uniform board-API 404, before any body parse or store read.
 */
export function authDisabledGate(): NextResponse | null {
  return getConfig().authMode === "optional" ? null : notFound();
}

export function userSessionDeps(): UserSessionDeps {
  return {
    users: getUserRepository(),
    sessionSecret: getConfig().sessionSecret,
    policy: getPolicy(),
  };
}

export function establishUserSessionDeps(): EstablishUserSessionDeps {
  return { ...userSessionDeps(), verifier: getTokenVerifier() };
}

export function claimDeps(authTimeMs?: number): ClaimDeps {
  return {
    boards: getBoardRepository(),
    users: getUserRepository(),
    policy: getPolicy(),
    ...(authTimeMs !== undefined ? { authTimeMs } : {}),
  };
}

/** Signed-in uid while sign-in is on (AUTH_MODE=optional); null when off or signed out (PIN-205 maker key). */
export async function signedInUserId(request: Request): Promise<string | null> {
  if (getConfig().authMode !== "optional") return null;
  return (await currentUserSession(request))?.user.uid ?? null;
}

/** Signed-in user for this request; null when signed out. */
export async function currentUser(request: Request): Promise<UserProfile | null> {
  const cookie = readCookieValue(request.headers.get("cookie"), USER_COOKIE_NAME);
  return resolveUserSession(cookie, userSessionDeps());
}

/**
 * Signed-in session (user + auth_time) for claim/restore routes
 * (PIN-94): the freshness gate reads authTimeMs from here.
 */
export async function currentUserSession(
  request: Request,
): Promise<UserSessionContext | null> {
  const cookie = readCookieValue(request.headers.get("cookie"), USER_COOKIE_NAME);
  return resolveUserSessionContext(cookie, userSessionDeps());
}
