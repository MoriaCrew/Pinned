import "server-only";
/**
 * Board host identity (PIN-103, docs/15-board-plus.md). The host
 * is the browser that created the board.
 *
 * Credential: at create the server draws a random 256-bit token
 * (generateAdminToken) and stores only its domain-separated sha256
 * plus the issue time on the Board (`Board.host`). The creator's
 * cookie carries the raw token behind a version prefix (`h1.`).
 * - Revocable: replacing or clearing `Board.host` kills the cookie;
 *   nothing else needs to change.
 * - Expiring: the stored `issuedAt` is checked server-side against
 *   Policy.plus.hostCookieDays, whatever the browser keeps.
 * - Independent of SESSION_SECRET: no HMAC, so rotating the secret
 *   never strips hosts, and a backend without a secret still has
 *   hosts.
 * - Domain-separated: the stored hash covers "pinned-host-v1:" +
 *   token, so it can never equal an admin-token hash (bare token)
 *   or a participant cookie hash (HMAC-signed JSON body).
 *
 * Cookie scope: Path=/api/boards/<slug> (not "/"), so the token is
 * only sent to that board's API — never to pages or other boards.
 * The server-rendered board page therefore cannot see it; the
 * board view API (under the path) reports `viewer.isHost`.
 */
import type { Board, BoardHost } from "../domain/board";
import { generateAdminToken, hashToken, verifyToken } from "../domain/tokens";
import type { Policy } from "../policy/policy";
import { readCookieValue } from "./board-session";

/** Cookie value version; bump with HOST_HASH_DOMAIN on any format change. */
const HOST_COOKIE_PREFIX = "h1.";
const HOST_HASH_DOMAIN = "pinned-host-v1:";
/** Shape of generateAdminToken(): 32 random bytes, base64url. */
const HOST_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const DAY_SECONDS = 24 * 60 * 60;
const DAY_MS = DAY_SECONDS * 1000;

export function hostCookieName(slug: string): string {
  return `pinned_host_${slug}`;
}

/** The only path the host cookie is sent to: this board's API. */
export function hostCookiePath(slug: string): string {
  return `/api/boards/${slug}`;
}

function hashHostToken(token: string): string {
  return hashToken(HOST_HASH_DOMAIN + token);
}

export interface IssuedHostCredential {
  /** Raw token: goes into the creator's cookie only, never stored. */
  token: string;
  /** What the Board stores. */
  record: BoardHost;
}

export function issueHostCredential(
  now: number,
  newToken: () => string = generateAdminToken,
): IssuedHostCredential {
  const token = newToken();
  return { token, record: { tokenHash: hashHostToken(token), issuedAt: now } };
}

/**
 * Cheap, I/O-free check of a presented cookie value: the raw token
 * when it has the current version prefix and token shape, else null.
 */
export function parseHostCookie(value: string | null | undefined): string | null {
  if (!value || !value.startsWith(HOST_COOKIE_PREFIX)) return null;
  const token = value.slice(HOST_COOKIE_PREFIX.length);
  return HOST_TOKEN_SHAPE.test(token) ? token : null;
}

/** This board's host token from the request cookie (shape-checked only). */
export function hostTokenFrom(request: Request, slug: string): string | null {
  return parseHostCookie(readCookieValue(request.headers.get("cookie"), hostCookieName(slug)));
}

/**
 * Full check against the stored credential: timing-safe hash
 * compare and server-side age against the board's effective
 * Policy. Null-safe on every stored field; never throws.
 */
export function verifyHostToken(
  board: Pick<Board, "host">,
  token: string | null,
  policy: Policy,
  now: number,
): boolean {
  const host = board.host;
  if (!token || host == null) return false;
  if (typeof host.tokenHash !== "string" || typeof host.issuedAt !== "number") return false;
  if (now - host.issuedAt > policy.plus.hostCookieDays * DAY_MS) return false;
  return verifyToken(HOST_HASH_DOMAIN + token, host.tokenHash);
}

export function hostCookieMaxAgeSeconds(policy: Policy): number {
  return policy.plus.hostCookieDays * DAY_SECONDS;
}

export function buildHostCookieHeader(
  slug: string,
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `${hostCookieName(slug)}=${encodeURIComponent(HOST_COOKIE_PREFIX + token)}`,
    `Path=${hostCookiePath(slug)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
