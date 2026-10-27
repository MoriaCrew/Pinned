/**
 * Player identity for one capability-link game (PIN-33 / PIN-7A).
 *
 * The browser cookie is an HMAC-signed payload under the server
 * SESSION_SECRET. The exact cookie value is also hashed into the
 * player record, so issuing a replacement cookie revokes the old
 * one. An optional 4-digit reclaim PIN lets a player recover the
 * same player ID on another device; only its domain-separated hash
 * is stored.
 */
import { randomUUID } from "node:crypto";
import type { GameRepository } from "../domain/repository";
import {
  hashToken,
  signPlayerCookie,
  verifyPlayerCookie,
  verifyToken,
} from "../domain/tokens";
import type { Game, Player, RoastLevel } from "../domain/types";

const ROAST_LEVELS: readonly RoastLevel[] = ["gentle", "spicy", "feral"];
const SESSION_TAIL_MS = 7 * 24 * 60 * 60 * 1000;

export class PlayerJoinError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 503 = 400,
  ) {
    super(message);
    this.name = "PlayerJoinError";
  }
}

export interface JoinGameInput {
  displayName: string;
  roastLevel: RoastLevel;
  posterOptIn: boolean;
  reclaimPin?: string;
}

export interface PlayerSessionDependencies {
  repository: GameRepository;
  sessionSecret: string | null;
  now?: () => number;
  createPlayerId?: () => string;
}

export interface JoinGameResult {
  player: Player;
  cookieValue: string;
  cookieExpiresAt: number;
  outcome: "created" | "updated" | "reclaimed";
}

export function playerCookieName(slug: string): string {
  return `pinned_player_${slug}`;
}

export function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new PlayerJoinError("Choose a display name.");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || [...name].length > 30 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new PlayerJoinError("Choose a display name up to 30 characters.");
  }
  return name;
}

export function parseJoinGameInput(value: unknown): JoinGameInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlayerJoinError("Send your display name and host preferences.");
  }
  const body = value as Record<string, unknown>;
  const roastLevel = body.roastLevel === undefined ? "spicy" : body.roastLevel;
  if (!ROAST_LEVELS.includes(roastLevel as RoastLevel)) {
    throw new PlayerJoinError("Choose a roast level.");
  }
  if (body.posterOptIn !== undefined && typeof body.posterOptIn !== "boolean") {
    throw new PlayerJoinError("Poster preference must be true or false.");
  }
  let reclaimPin: string | undefined;
  if (body.reclaimPin !== undefined && body.reclaimPin !== "") {
    if (typeof body.reclaimPin !== "string" || !/^\d{4}$/.test(body.reclaimPin)) {
      throw new PlayerJoinError("Reclaim PIN must be exactly four digits.");
    }
    reclaimPin = body.reclaimPin;
  }
  return {
    displayName: normalizeDisplayName(body.displayName),
    roastLevel: roastLevel as RoastLevel,
    posterOptIn: body.posterOptIn ?? true,
    reclaimPin,
  };
}

function requireSessionSecret(secret: string | null): string {
  if (!secret || secret.length < 32) {
    throw new PlayerJoinError("Player sessions are not configured on this server.", 503);
  }
  return secret;
}

function reclaimPinHash(slug: string, pin: string): string {
  return hashToken(`${slug}:${pin}`);
}

async function issueSession(
  player: Player,
  deps: PlayerSessionDependencies,
  game: Game,
  now: number,
  outcome: JoinGameResult["outcome"],
): Promise<JoinGameResult> {
  const secret = requireSessionSecret(deps.sessionSecret);
  let issuedAt = now;
  let cookieValue = signPlayerCookie(
    { gameId: game.id, playerId: player.id, issuedAt },
    secret,
  );
  if (player.cookieSecretHash && hashToken(cookieValue) === player.cookieSecretHash) {
    issuedAt += 1;
    cookieValue = signPlayerCookie(
      { gameId: game.id, playerId: player.id, issuedAt },
      secret,
    );
  }
  const persisted: Player = { ...player, cookieSecretHash: hashToken(cookieValue) };
  await deps.repository.putPlayer(persisted);
  return {
    player: persisted,
    cookieValue,
    cookieExpiresAt: game.deadlineAt + SESSION_TAIL_MS,
    outcome,
  };
}

export function readCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export async function resolvePlayerSession(
  slug: string,
  cookieValue: string | null,
  deps: PlayerSessionDependencies,
): Promise<Player | null> {
  if (!cookieValue || !deps.sessionSecret || deps.sessionSecret.length < 32) return null;
  const now = deps.now?.() ?? Date.now();
  const payload = verifyPlayerCookie(cookieValue, deps.sessionSecret, {
    now,
    maxAgeMs: 72 * 60 * 60 * 1000 + SESSION_TAIL_MS,
  });
  if (!payload || payload.gameId !== slug) return null;
  const player = await deps.repository.getPlayer(slug, payload.playerId);
  if (!player || !verifyToken(cookieValue, player.cookieSecretHash)) return null;
  return player;
}

function assertJoinable(game: Game, now: number): void {
  if (game.state !== "OPEN" || now >= game.deadlineAt) {
    throw new PlayerJoinError("This game is no longer open for new players.", 409);
  }
}

export async function joinGame(
  slug: string,
  rawInput: unknown,
  existingCookieValue: string | null,
  deps: PlayerSessionDependencies,
): Promise<JoinGameResult> {
  requireSessionSecret(deps.sessionSecret);
  const input = parseJoinGameInput(rawInput);
  const now = deps.now?.() ?? Date.now();
  const game = await deps.repository.getGame(slug);
  if (!game) throw new PlayerJoinError("Game not found.", 404);
  assertJoinable(game, now);

  const updates = {
    displayName: input.displayName,
    roastLevel: input.roastLevel,
    posterOptIn: input.posterOptIn,
    ...(input.reclaimPin
      ? { reclaimPinHash: reclaimPinHash(slug, input.reclaimPin) }
      : {}),
  };

  const existing = await resolvePlayerSession(slug, existingCookieValue, deps);
  if (existing) {
    return issueSession({ ...existing, ...updates }, deps, game, now, "updated");
  }

  if (input.reclaimPin) {
    const wantedName = input.displayName.toLowerCase();
    const candidates = (await deps.repository.listPlayers(slug)).filter(
      (player) => player.displayName.toLowerCase() === wantedName && player.reclaimPinHash,
    );
    const reclaimed = candidates.find((player) =>
      verifyToken(`${slug}:${input.reclaimPin}`, player.reclaimPinHash as string),
    );
    if (reclaimed) {
      return issueSession({ ...reclaimed, ...updates }, deps, game, now, "reclaimed");
    }
  }

  const player: Player = {
    id: deps.createPlayerId?.() ?? randomUUID(),
    gameId: slug,
    displayName: input.displayName,
    cookieSecretHash: "",
    roastLevel: input.roastLevel,
    posterOptIn: input.posterOptIn,
    ...(input.reclaimPin
      ? { reclaimPinHash: reclaimPinHash(slug, input.reclaimPin) }
      : {}),
    createdAt: now,
  };
  return issueSession(player, deps, game, now, "created");
}

export function buildPlayerCookieHeader(
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

export function publicPlayer(player: Player) {
  return {
    id: player.id,
    gameId: player.gameId,
    displayName: player.displayName,
    roastLevel: player.roastLevel,
    posterOptIn: player.posterOptIn,
    hasReclaimPin: Boolean(player.reclaimPinHash),
    createdAt: player.createdAt,
  };
}
