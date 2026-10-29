import "server-only";
/**
 * Board participant identity (PIN-65, docs/11 section 5.4): the
 * Studio name for the existing link-only join identity. Same
 * mechanics as player-session.ts — HMAC-signed cookie under
 * SESSION_SECRET, the cookie value hashed into the Participant
 * record (a replacement cookie revokes the old one), an optional
 * 4-digit reclaim PIN whose domain-separated hash only is stored —
 * but against BoardRepository/Participant and with every cap from
 * Policy. The cookie payload reuses the player shape
 * (gameId = board slug, playerId = participant id) and the same
 * cookie name, so one browser identity carries across the pivot.
 *
 * PIN-90 hardens the reclaim path: a PIN-bearing join against an
 * existing name either reclaims it or fails with ONE uniform error
 * (wrong PIN, no PIN on file, and locked-out are byte-identical to
 * the caller, with a dummy hash check on every failure path).
 * Failures are counted per (board, name) and per (board, IP) in the
 * BoardRepository — shared across instances — with Policy-owned
 * thresholds and an exponentially growing lockout. A PIN-bearing
 * join for a name nobody has taken is still a first join (it sets
 * the PIN), and a first-try correct reclaim succeeds unchanged.
 */
import { randomUUID } from "node:crypto";
import type { Participant } from "../domain/board";
import type { BoardRepository } from "../domain/board-repository";
import {
  isReclaimLocked,
  recordReclaimFailure,
  type ReclaimLockoutParams,
} from "../domain/reclaim-lockout";
import {
  hashToken,
  signPlayerCookie,
  verifyPlayerCookie,
  verifyToken,
} from "../domain/tokens";
import type { Policy } from "../policy/policy";
import {
  PlayerJoinError,
  normalizeDisplayName,
  playerCookieName,
  readCookieValue,
} from "./player-session";

export { playerCookieName, readCookieValue };

const DAY_MS = 24 * 60 * 60 * 1000;

export class BoardApiError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 401 | 404 | 409 | 413 | 415 | 429 | 503 = 400,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "BoardApiError";
  }
}

export interface BoardSessionDeps {
  boards: BoardRepository;
  sessionSecret: string | null;
  policy: Policy;
  now?: () => number;
  createParticipantId?: () => string;
}

export interface JoinBoardResult {
  participant: Participant;
  cookieValue: string;
  cookieExpiresAt: number;
  outcome: "created" | "updated" | "reclaimed" | "restored";
}

/** Per-request join context; the IP only ever reaches storage hashed. */
export interface JoinBoardContext {
  clientIp?: string | null;
}

function requireSessionSecret(secret: string | null): string {
  if (!secret || secret.length < 32) {
    throw new BoardApiError("Board sessions are not configured on this server.", 503);
  }
  return secret;
}

function reclaimPinHash(slug: string, pin: string): string {
  return hashToken(`${slug}:${pin}`);
}

/** The one reclaim-failure error: same status/body for every cause. */
function reclaimFailedError(): BoardApiError {
  return new BoardApiError(
    "That name and secret number didn't match. Check both and try again.",
    401,
    "reclaim_failed",
  );
}

/** Dummy hash so failed reclaims do the same hash work as real ones. */
const DUMMY_PIN_HASH = hashToken("pinned-reclaim:v1:dummy");

function nameAttemptKey(slug: string, lowerName: string): string {
  return hashToken(`pinned-reclaim:v1:name:${slug}:${lowerName}`);
}

function ipAttemptKey(slug: string, clientIp: string): string {
  return hashToken(`pinned-reclaim:v1:ip:${slug}:${clientIp}`);
}

function nameLockoutParams(policy: Policy): ReclaimLockoutParams {
  return {
    maxFailures: policy.reclaimMaxFailuresPerName,
    failureWindowMs: policy.reclaimFailureWindowMs,
    lockoutBaseMs: policy.reclaimLockoutBaseMs,
    lockoutMaxMs: policy.reclaimLockoutMaxMs,
  };
}

function ipLockoutParams(policy: Policy): ReclaimLockoutParams {
  return {
    maxFailures: policy.reclaimMaxFailuresPerIp,
    failureWindowMs: policy.reclaimFailureWindowMs,
    lockoutBaseMs: policy.reclaimLockoutBaseMs,
    lockoutMaxMs: policy.reclaimLockoutMaxMs,
  };
}

export interface JoinBoardInput {
  displayName: string;
  reclaimPin?: string;
}

export function parseJoinBoardInput(value: unknown): JoinBoardInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoardApiError("Send your display name.");
  }
  const body = value as Record<string, unknown>;
  let reclaimPin: string | undefined;
  if (body.reclaimPin !== undefined && body.reclaimPin !== "") {
    if (typeof body.reclaimPin !== "string" || !/^\d{4}$/.test(body.reclaimPin)) {
      throw new BoardApiError("Reclaim PIN must be exactly four digits.");
    }
    reclaimPin = body.reclaimPin;
  }
  try {
    return { displayName: normalizeDisplayName(body.displayName), reclaimPin };
  } catch (error) {
    if (error instanceof PlayerJoinError) {
      throw new BoardApiError(error.message, 400);
    }
    throw error;
  }
}

async function issueSession(
  participant: Participant,
  deps: BoardSessionDeps,
  now: number,
  outcome: JoinBoardResult["outcome"],
): Promise<JoinBoardResult> {
  const secret = requireSessionSecret(deps.sessionSecret);
  let issuedAt = now;
  let cookieValue = signPlayerCookie(
    { gameId: participant.boardId, playerId: participant.id, issuedAt },
    secret,
  );
  if (
    participant.cookieSecretHash &&
    hashToken(cookieValue) === participant.cookieSecretHash
  ) {
    issuedAt += 1;
    cookieValue = signPlayerCookie(
      { gameId: participant.boardId, playerId: participant.id, issuedAt },
      secret,
    );
  }
  const persisted: Participant = {
    ...participant,
    cookieSecretHash: hashToken(cookieValue),
  };
  await deps.boards.putParticipant(persisted);
  return {
    participant: persisted,
    cookieValue,
    cookieExpiresAt: now + deps.policy.participantCookieDays * DAY_MS,
    outcome,
  };
}

/** Resolve the signed cookie to a Participant; null = not joined. */
export async function resolveParticipantSession(
  slug: string,
  cookieValue: string | null,
  deps: BoardSessionDeps,
): Promise<Participant | null> {
  if (!cookieValue || !deps.sessionSecret || deps.sessionSecret.length < 32) {
    return null;
  }
  const now = deps.now?.() ?? Date.now();
  const payload = verifyPlayerCookie(cookieValue, deps.sessionSecret, {
    now,
    maxAgeMs: deps.policy.participantCookieDays * DAY_MS,
  });
  if (!payload || payload.gameId !== slug) return null;
  const participant = await deps.boards.getParticipant(slug, payload.playerId);
  if (!participant || !verifyToken(cookieValue, participant.cookieSecretHash)) {
    return null;
  }
  return participant;
}

/**
 * Cross-device restore (PIN-84): re-issue the participant cookie
 * for an identity the caller has already proven belongs to the
 * signed-in user (user-session findClaimedParticipant). Like the
 * reclaim-PIN path this rotates cookieSecretHash, so the previous
 * device's cookie stops working — the single-hash record cannot
 * hold two live cookies. slug is still required to reach here.
 */
export async function restoreParticipantSession(
  participant: Participant,
  deps: BoardSessionDeps,
): Promise<JoinBoardResult> {
  const now = deps.now?.() ?? Date.now();
  return issueSession(participant, deps, now, "restored");
}

/**
 * PIN-90 reclaim attempt against an existing name. Returns the
 * reclaimed participant, or throws the one uniform failure error.
 * Locks are checked before any PIN verification (a locked name/IP
 * refuses even the correct PIN until the lock expires), and locked
 * attempts do not extend the lock. Every failure path runs at
 * least one hash verification so timing stays coarse-uniform.
 */
async function attemptReclaim(
  slug: string,
  input: Required<JoinBoardInput>,
  sameName: Participant[],
  deps: BoardSessionDeps,
  now: number,
  context: JoinBoardContext | undefined,
): Promise<Participant> {
  const nameKey = nameAttemptKey(slug, input.displayName.toLowerCase());
  const ipKey = context?.clientIp ? ipAttemptKey(slug, context.clientIp) : null;
  const token = `${slug}:${input.reclaimPin}`;

  const nameState = await deps.boards.getReclaimAttempt(slug, nameKey);
  const ipState = ipKey ? await deps.boards.getReclaimAttempt(slug, ipKey) : null;
  if (isReclaimLocked(nameState, now) || isReclaimLocked(ipState, now)) {
    verifyToken(token, DUMMY_PIN_HASH);
    throw reclaimFailedError();
  }

  const candidates = sameName.filter((p) => p.reclaimPinHash);
  let reclaimed: Participant | undefined;
  if (candidates.length === 0) {
    verifyToken(token, DUMMY_PIN_HASH);
  } else {
    reclaimed = candidates.find((p) =>
      verifyToken(token, p.reclaimPinHash as string),
    );
  }

  if (!reclaimed) {
    await deps.boards.mutateReclaimAttempt(slug, nameKey, (current) =>
      recordReclaimFailure(slug, nameKey, current, now, nameLockoutParams(deps.policy)),
    );
    if (ipKey) {
      await deps.boards.mutateReclaimAttempt(slug, ipKey, (current) =>
        recordReclaimFailure(slug, ipKey, current, now, ipLockoutParams(deps.policy)),
      );
    }
    throw reclaimFailedError();
  }

  await deps.boards.mutateReclaimAttempt(slug, nameKey, () => null);
  if (ipKey) {
    await deps.boards.mutateReclaimAttempt(slug, ipKey, () => null);
  }
  return reclaimed;
}

export async function joinBoard(
  slug: string,
  rawInput: unknown,
  existingCookieValue: string | null,
  deps: BoardSessionDeps,
  context?: JoinBoardContext,
): Promise<JoinBoardResult> {
  requireSessionSecret(deps.sessionSecret);
  const input = parseJoinBoardInput(rawInput);
  const now = deps.now?.() ?? Date.now();
  const board = await deps.boards.getBoard(slug);
  if (!board) throw new BoardApiError("Board not found.", 404);

  const updates = {
    displayName: input.displayName,
    ...(input.reclaimPin
      ? { reclaimPinHash: reclaimPinHash(slug, input.reclaimPin) }
      : {}),
  };

  const existing = await resolveParticipantSession(slug, existingCookieValue, deps);
  if (existing) {
    return issueSession({ ...existing, ...updates }, deps, now, "updated");
  }

  if (input.reclaimPin) {
    const wantedName = input.displayName.toLowerCase();
    const sameName = (await deps.boards.listParticipants(slug)).filter(
      (p) => p.displayName.toLowerCase() === wantedName,
    );
    if (sameName.length > 0) {
      const reclaimed = await attemptReclaim(
        slug,
        { displayName: input.displayName, reclaimPin: input.reclaimPin },
        sameName,
        deps,
        now,
        context,
      );
      return issueSession({ ...reclaimed, ...updates }, deps, now, "reclaimed");
    }
  }

  const roster = await deps.boards.listParticipants(slug);
  if (roster.length >= deps.policy.participantsPerBoard) {
    throw new BoardApiError("This board is full.", 409);
  }

  const participant: Participant = {
    id: deps.createParticipantId?.() ?? randomUUID(),
    boardId: slug,
    displayName: input.displayName,
    cookieSecretHash: "",
    ...(input.reclaimPin
      ? { reclaimPinHash: reclaimPinHash(slug, input.reclaimPin) }
      : {}),
    createdAt: now,
  };
  return issueSession(participant, deps, now, "created");
}

export function buildParticipantCookieHeader(
  slug: string,
  value: string,
  expiresAt: number,
  secure: boolean,
): string {
  const parts = [
    `${playerCookieName(slug)}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function publicParticipant(participant: Participant) {
  return {
    id: participant.id,
    boardId: participant.boardId,
    displayName: participant.displayName,
    hasReclaimPin: Boolean(participant.reclaimPinHash),
    createdAt: participant.createdAt,
  };
}
