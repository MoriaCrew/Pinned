import "server-only";
import { getConfig } from "../config";
/**
 * Best-effort in-process rate limiting (PIN-43).
 *
 * App Hosting runs a small number of instances, so this is a soft
 * brake against scripts and PIN brute-force, not a distributed
 * guarantee. Game-level caps in the domain remain the hard limits.
 * The distributed reclaim-PIN lockout lives in the BoardRepository
 * attempt counters (PIN-90, board-session.ts), as does the
 * per-IP new-join budget (PIN-91) — this in-process brake stays
 * as the cheap first gate on the join route.
 */
const globalBuckets = globalThis as typeof globalThis & {
  __pinnedRateLimits?: Map<string, { count: number; resetAt: number }>;
};

function buckets(): Map<string, { count: number; resetAt: number }> {
  globalBuckets.__pinnedRateLimits ??= new Map();
  return globalBuckets.__pinnedRateLimits;
}

/** True when the call is allowed; records the attempt either way. */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  const store = buckets();
  const existing = store.get(key);
  if (!existing || now >= existing.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return 1 <= limit;
  }
  existing.count += 1;
  return existing.count <= limit;
}

export interface ClientIpOptions {
  /** X-Forwarded-For entries the platform appends after the client; null = first entry. */
  trustedHops: number | null;
  /** Platform header read first when configured; null = off. */
  header: string | null;
}

/** X-Forwarded-For entries, trimmed, empty ones dropped. */
export function forwardedEntries(headers: Headers): string[] {
  return (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Rate-limit address (PIN-112). Without a hop count: the first
 * X-Forwarded-For entry, as before. With n hops: the entry n
 * positions from the right end, i.e. the address the platform
 * appended; entries before it are ignored. Too few entries fall
 * back to the first one, never to a shared constant. A configured
 * header wins only when it holds a single value.
 */
export function pickClientIp(headers: Headers, options: ClientIpOptions): string {
  if (options.header) {
    const direct = headers.get(options.header)?.trim();
    if (direct && !direct.includes(",")) return direct;
  }
  const hops = options.trustedHops;
  if (hops !== null) {
    const entries = forwardedEntries(headers);
    if (entries.length > hops) return entries[entries.length - 1 - hops];
  }
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip") || "unknown";
}

/** Client address per config, or "unknown" (PIN-90 hashes before storage). */
export function clientIp(request: Request): string {
  const cfg = getConfig();
  return pickClientIp(request.headers, {
    trustedHops: cfg.clientIpTrustedHops,
    header: cfg.clientIpHeader,
  });
}

export function clientKey(request: Request, scope: string): string {
  return `${scope}:${clientIp(request)}`;
}

export const RATE_LIMITS = {
  playersPerIpGame: { limit: 20, windowMs: 10 * 60_000 },
  submissionsPerIpGame: { limit: 30, windowMs: 10 * 60_000 },
  labPerIp: { limit: 20, windowMs: 10 * 60_000 },
  // Global per-IP upload brake across boards (the per-game gate
  // above alone lets one IP rotate slugs), wired on the upload
  // entry points that exist today.
  uploadsPerIp: { limit: 60, windowMs: 60 * 60_000 },
  // PIN-83: sign-in/claim brake (token guessing is pointless
  // against Firebase verify, but keep the entry point gated).
  authSessionPerIp: { limit: 20, windowMs: 10 * 60_000 },
} as const;
