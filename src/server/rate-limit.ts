import "server-only";
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

/** First forwarded IP, or "unknown" (PIN-90 hashes before storage). */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
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
