import "server-only";
/**
 * Signed-in user session + participant claim (PIN-83, docs/11
 * section 5.4). Only reachable when AUTH_MODE=optional — every
 * route 404s in link-only mode before touching this module's
 * logic, and joinBoard's auto-link is gated the same way, so the
 * link-only board flow stays byte-identical.
 *
 * Session: the client (PIN-84) sends a Firebase ID token once;
 * the TokenVerifier checks it and this module mints the same
 * style of HMAC-signed httpOnly cookie the board participant
 * session uses (domain/tokens, domain-separated user payload),
 * with its life from Policy.userSessionDays. The cookie alone is
 * not the session of record: resolveUserSession also loads the
 * users/{uid} profile, so a deleted profile signs nobody in.
 *
 * Claim: participant cookie (board identity) + user session ->
 * set Participant.userId when empty or already the same, else
 * 409; the users/{uid}/boards/{slug} index is written on claim
 * and refreshed on join-while-signed-in. Join auto-link never
 * overwrites another user's claim and never fails the join —
 * the explicit claim route is where a conflict surfaces as 409.
 */
import type { Participant } from "../domain/board";
import type { BoardRepository } from "../domain/board-repository";
import { signUserCookie, verifyUserCookie } from "../domain/tokens";
import type { UserProfile } from "../domain/user";
import type { UserRepository } from "../domain/user-repository";
import type { Policy } from "../policy/policy";
import { BoardApiError } from "./board-session";
import type { TokenVerifier } from "./token-verifier";

export const USER_COOKIE_NAME = "pinned_user";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Firebase uids are URL/path-safe; anything else never reaches a doc id. */
const SAFE_UID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeUid(uid: string): boolean {
  return SAFE_UID.test(uid);
}

export interface UserSessionDeps {
  users: UserRepository;
  sessionSecret: string | null;
  policy: Policy;
  now?: () => number;
}

export interface EstablishUserSessionDeps extends UserSessionDeps {
  verifier: TokenVerifier;
}

export interface ClaimDeps {
  boards: BoardRepository;
  users: UserRepository;
  now?: () => number;
}

export interface EstablishedUserSession {
  user: UserProfile;
  cookieValue: string;
  cookieExpiresAt: number;
}

function requireSessionSecret(secret: string | null): string {
  if (!secret || secret.length < 32) {
    throw new BoardApiError("Sign-in is not configured on this server.", 503);
  }
  return secret;
}

export function parseEstablishSessionInput(value: unknown): { idToken: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoardApiError("Send your sign-in token.");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.idToken !== "string" || !body.idToken) {
    throw new BoardApiError("Send your sign-in token.");
  }
  return { idToken: body.idToken };
}

/** ID token -> verified profile upsert + signed user cookie. */
export async function establishUserSession(
  rawInput: unknown,
  deps: EstablishUserSessionDeps,
): Promise<EstablishedUserSession> {
  const secret = requireSessionSecret(deps.sessionSecret);
  const { idToken } = parseEstablishSessionInput(rawInput);
  const identity = await deps.verifier.verifyIdToken(idToken);
  if (!identity || !isSafeUid(identity.uid)) {
    throw new BoardApiError("Sign-in failed. Please try again.", 401, "invalid_token");
  }
  const now = deps.now?.() ?? Date.now();
  const existing = await deps.users.getUser(identity.uid);
  const displayName = identity.displayName ?? existing?.displayName;
  const photoUrl = identity.photoUrl ?? existing?.photoUrl;
  const user: UserProfile = {
    uid: identity.uid,
    ...(displayName ? { displayName } : {}),
    ...(photoUrl ? { photoUrl } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await deps.users.putUser(user);
  const cookieValue = signUserCookie({ v: 1, uid: user.uid, issuedAt: now }, secret);
  return {
    user,
    cookieValue,
    cookieExpiresAt: now + deps.policy.userSessionDays * DAY_MS,
  };
}

/** Resolve the signed user cookie to a profile; null = signed out. */
export async function resolveUserSession(
  cookieValue: string | null,
  deps: UserSessionDeps,
): Promise<UserProfile | null> {
  if (!cookieValue || !deps.sessionSecret || deps.sessionSecret.length < 32) {
    return null;
  }
  const now = deps.now?.() ?? Date.now();
  const payload = verifyUserCookie(cookieValue, deps.sessionSecret, {
    now,
    maxAgeMs: deps.policy.userSessionDays * DAY_MS,
  });
  if (!payload || !isSafeUid(payload.uid)) return null;
  return deps.users.getUser(payload.uid);
}

/** Write/refresh users/{uid}/boards/{slug}, keeping the first claimedAt. */
async function writeBoardIndex(
  participant: Participant,
  user: UserProfile,
  deps: ClaimDeps,
  now: number,
): Promise<void> {
  const existing = await deps.users.getUserBoard(user.uid, participant.boardId);
  await deps.users.putUserBoard(user.uid, {
    boardId: participant.boardId,
    participantId: participant.id,
    claimedAt: existing?.claimedAt ?? now,
    updatedAt: now,
  });
}

/**
 * Claim a participant for a signed-in user: empty userId -> set,
 * same userId -> ok (index refreshed), another user's -> 409.
 */
export async function claimParticipantForUser(
  participant: Participant,
  user: UserProfile,
  deps: ClaimDeps,
): Promise<Participant> {
  const now = deps.now?.() ?? Date.now();
  if (participant.userId && participant.userId !== user.uid) {
    throw new BoardApiError(
      "This board identity is already linked to a different account.",
      409,
      "claim_conflict",
    );
  }
  let claimed = participant;
  if (!participant.userId) {
    claimed = { ...participant, userId: user.uid };
    await deps.boards.putParticipant(claimed);
  }
  await writeBoardIndex(claimed, user, deps, now);
  return claimed;
}

/**
 * Join-while-signed-in auto-link: claim semantics, but a
 * different user's existing claim is left untouched (never
 * overwritten, never an error) so joining a board can never be
 * blocked by optional sign-in. Returns the participant to use.
 */
export async function linkParticipantOnJoin(
  participant: Participant,
  user: UserProfile | null,
  deps: ClaimDeps,
): Promise<Participant> {
  if (!user) return participant;
  if (participant.userId && participant.userId !== user.uid) return participant;
  return claimParticipantForUser(participant, user, deps);
}

/**
 * Restore lookup (PIN-84): the participant on `slug` claimed by
 * this user, via the users/{uid}/boards/{slug} index. The index
 * alone never suffices — the participant record must still carry
 * userId === uid, so a stale or forged index entry restores
 * nobody. Returns null when the user has no claim on the board.
 */
export async function findClaimedParticipant(
  slug: string,
  user: UserProfile,
  deps: ClaimDeps,
): Promise<Participant | null> {
  const entry = await deps.users.getUserBoard(user.uid, slug);
  if (!entry) return null;
  const participant = await deps.boards.getParticipant(slug, entry.participantId);
  if (!participant || participant.userId !== user.uid) return null;
  return participant;
}

export function buildUserCookieHeader(
  value: string,
  expiresAt: number,
  secure: boolean,
): string {
  const parts = [
    `${USER_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearUserCookieHeader(secure: boolean): string {
  const parts = [
    `${USER_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function publicUser(user: UserProfile) {
  return {
    uid: user.uid,
    displayName: user.displayName ?? null,
    photoUrl: user.photoUrl ?? null,
    createdAt: user.createdAt,
  };
}
