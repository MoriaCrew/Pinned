import { NextResponse } from "next/server";
import { t } from "../../../../../i18n";
import { getLocale } from "../../../../../i18n/server";
import { getCheckout } from "../../../../../billing/server";
import { startBoardPlus } from "../../../../../server/board-plus";
import { hostRouteDeps, hostRouteGate, plusErrorResponse } from "../../plus-shared";
import { JSON_HEADERS, policyForBoard, slugGate } from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start Board Plus (PIN-103): JSON { plan: "board" | "host" } ->
 * 200 { status: "granted", plus } | { status: "unavailable" } |
 * { status: "redirect", url }. Same gates as the skin route (bad
 * slug 404; cross-site 403, non-JSON 415, per-IP 429, host cookie
 * 403, body 413; host token vs stored hash 403), then bad plan
 * 400. PLUS_MODE=off answers "unavailable" and writes nothing;
 * mock grants at once.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const locale = await getLocale();
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  try {
    const gate = await hostRouteGate(request, slug);
    if (!gate.ok) return gate.response;
    const policy = await policyForBoard(slug);
    const result = await startBoardPlus(slug, gate.hostToken, gate.body, {
      ...hostRouteDeps(policy),
      checkout: getCheckout(),
    });
    return NextResponse.json(result, { headers: JSON_HEADERS });
  } catch (error) {
    return plusErrorResponse(error, t(locale, "request.plusUnavailable"));
  }
}
