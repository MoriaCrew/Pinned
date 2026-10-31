import { NextResponse } from "next/server";
import { getConfig } from "../../../../config";
import {
  RATE_LIMITS,
  checkRateLimit,
  clientKey,
  forwardedEntries,
} from "../../../../server/rate-limit";

/**
 * Forwarding-layout probe (PIN-112). Answers only the shape of the
 * forwarding headers this backend receives, never an address, and
 * logs nothing. It tells the operator which CLIENT_IP_TRUSTED_HOPS
 * value matches the platform (SECURITY.md):
 *
 * 1. Plain `curl https://<dev host>/api/lab/client-ip` → xffEntries
 *    and fahIndexFromRight (position of the x-fah-client-ip value,
 *    counted from the right, 0-based) for a normal request.
 * 2. Add `-H "X-Forwarded-For: 192.0.2.1, 198.51.100.2"` → xffEntries
 *    should rise by 2 while fahIndexFromRight stays: the platform
 *    appends, and the hop count is that index. Without
 *    x-fah-client-ip, a plain request's xffEntries - 1 is the count.
 * 3. Add `-H "x-fah-client-ip: 203.0.113.3"` → an unchanged
 *    fahIndexFromRight means the platform overwrites that header;
 *    null means it does not, so CLIENT_IP_HEADER must stay unset.
 * 4. Repeat a few times, and once with `curl -6`, for stability.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JSON_HEADERS = { "Cache-Control": "no-store" };

/** Lab exists on dev (PINNED_LAB=1) and local memory mode only. */
function labAvailable(): boolean {
  const cfg = getConfig();
  return cfg.labEnabled || cfg.dataBackend === "memory";
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!labAvailable()) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: JSON_HEADERS });
  }
  const gate = RATE_LIMITS.labPerIp;
  if (!checkRateLimit(clientKey(request, "lab"), gate.limit, gate.windowMs)) {
    return NextResponse.json({ error: "Lab rate limit reached. Try again in a few minutes." }, { status: 429, headers: JSON_HEADERS });
  }
  const entries = forwardedEntries(request.headers);
  const fah = request.headers.get("x-fah-client-ip")?.trim() || null;
  // Rightmost match: a supplied copy on the left never wins.
  const fahAt = fah ? entries.lastIndexOf(fah) : -1;
  return NextResponse.json(
    {
      xffEntries: entries.length,
      hasFahClientIp: fah !== null,
      fahIndexFromRight: fahAt >= 0 ? entries.length - 1 - fahAt : null,
      hasXRealIp: Boolean(request.headers.get("x-real-ip")?.trim()),
      configuredHops: getConfig().clientIpTrustedHops,
    },
    { headers: JSON_HEADERS },
  );
}
