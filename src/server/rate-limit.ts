import "server-only";
/**
 * Best-effort in-process rate limiting (PIN-43).
 *
 * App Hosting runs a small number of instances, so this is a soft
 * brake against scripts and PIN brute-force, not a distributed
 * guarantee. Game-level caps in the domain remain the hard limits.
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

export function clientKey(request: Request, scope: string): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip") || "unknown";
  return `${scope}:${ip}`;
}

export const RATE_LIMITS = {
  playersPerIpGame: { limit: 20, windowMs: 10 * 60_000 },
  submissionsPerIpGame: { limit: 30, windowMs: 10 * 60_000 },
  labPerIp: { limit: 20, windowMs: 10 * 60_000 },
} as const;
