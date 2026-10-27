/**
 * Capability helpers (PIN-5, FR2.1/FR8.1). node:crypto only.
 * - Game slug: 128-bit random, base64url (unguessable capability URL)
 * - Admin token: 256-bit random; only its sha256 hash is stored
 * - Player cookie: HMAC-signed payload; verify never throws
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** 128-bit capability slug for /g/{slug}. */
export function generateSlug(): string {
  return b64url(randomBytes(16));
}

/** Raw admin token shown to the creator exactly once. */
export function generateAdminToken(): string {
  return b64url(randomBytes(32));
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, "hex");
  } catch {
    return false;
  }
  return safeEqual(actual, expected);
}

export interface PlayerCookiePayload {
  gameId: string;
  playerId: string;
  issuedAt: number;
}

function requireSecret(secret: string): void {
  if (!secret) throw new RangeError("Cookie signing secret must not be empty");
}

export function signPlayerCookie(payload: PlayerCookiePayload, secret: string): string {
  requireSecret(secret);
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyPlayerCookie(
  value: string,
  secret: string,
  options: { now?: number; maxAgeMs?: number } = {},
): PlayerCookiePayload | null {
  if (!secret || !value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PlayerCookiePayload;
    if (typeof payload.gameId !== "string" || typeof payload.playerId !== "string") return null;
    if (typeof payload.issuedAt !== "number") return null;
    if (options.maxAgeMs !== undefined) {
      const now = options.now ?? Date.now();
      if (now - payload.issuedAt > options.maxAgeMs) return null;
    }
    return payload;
  } catch {
    return null;
  }
}
