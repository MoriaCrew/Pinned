import "server-only";
/**
 * Board host identity (PIN-103, docs/15-board-plus.md). The host
 * is the browser that created the board: POST /api/boards sets a
 * per-slug host cookie whose value is
 * HMAC-SHA256(SESSION_SECRET, "host:" + slug), base64url. Same
 * secret and minimum length as the participant cookie
 * (board-session.ts), same attributes (httpOnly, SameSite=Lax,
 * Path=/, Secure on https), life from Policy.plus.hostCookieDays.
 *
 * Domain separation: participant/user cookies sign a base64url
 * JSON body (no ":" can appear) or a "pinned-user-v1:" prefix, so
 * no other cookie this server mints can verify as a host token.
 *
 * Limits (deliberate for v1, see docs/15): the token is
 * stateless and deterministic per (secret, slug) — no record, no
 * server-side expiry, no hand-off. Revoking it means rotating
 * SESSION_SECRET, which also signs every participant out.
 * Without a usable secret nobody is host (verify fails closed).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Policy } from "../policy/policy";
import { readCookieValue } from "./board-session";

const HOST_TOKEN_DOMAIN = "host:";
/** Same floor board-session applies before signing anything. */
const MIN_SECRET_LENGTH = 32;
const DAY_SECONDS = 24 * 60 * 60;

export function hostCookieName(slug: string): string {
  return `pinned_host_${slug}`;
}

function usableSecret(secret: string | null | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

/** Host token for a slug; null when sessions are not configured. */
export function signHostToken(slug: string, secret: string | null): string | null {
  if (!usableSecret(secret)) return null;
  return createHmac("sha256", secret)
    .update(HOST_TOKEN_DOMAIN + slug, "utf8")
    .digest("base64url");
}

/** Timing-safe check of a presented token; never throws. */
export function verifyHostToken(
  slug: string,
  token: string | null | undefined,
  secret: string | null,
): boolean {
  if (!token) return false;
  const expected = signHostToken(slug, secret);
  if (!expected) return false;
  const presented = Buffer.from(token, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return presented.length === wanted.length && timingSafeEqual(presented, wanted);
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
    `${hostCookieName(slug)}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export interface HostCookieDeps {
  sessionSecret: string | null;
  policy: Policy;
}

/**
 * Set-Cookie value making this browser the board's host; null
 * when sessions are not configured (the board is still created,
 * it just has no host — same degrade as joining without a secret).
 */
export function issueHostCookie(
  slug: string,
  secure: boolean,
  deps: HostCookieDeps,
): string | null {
  const token = signHostToken(slug, deps.sessionSecret);
  if (!token) return null;
  return buildHostCookieHeader(slug, token, hostCookieMaxAgeSeconds(deps.policy), secure);
}

/** True when the request carries this board's valid host cookie. */
export function isHostRequest(
  request: Request,
  slug: string,
  sessionSecret: string | null,
): boolean {
  const token = readCookieValue(request.headers.get("cookie"), hostCookieName(slug));
  return verifyHostToken(slug, token, sessionSecret);
}
