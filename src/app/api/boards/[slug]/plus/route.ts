import { NextResponse } from "next/server";
import { getCheckout } from "../../../../../billing/server";
import { getConfig } from "../../../../../config";
import { startBoardPlus } from "../../../../../server/board-plus";
import { getBoardRepository } from "../../../../../server/board-repository";
import { hostFor, plusErrorResponse, readJsonBody } from "../../plus-shared";
import { JSON_HEADERS, policyForBoard, slugGate } from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start Board Plus (PIN-103): { plan: "board" | "host" } ->
 * 200 { status: "granted", plus } | { status: "unavailable" } |
 * { status: "redirect", url }. Bad slug 404 first; host cookie
 * 403; unknown board 404; bad plan 400. PLUS_MODE=off answers
 * "unavailable" and writes nothing; mock grants at once.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  try {
    const policy = await policyForBoard(slug);
    const result = await startBoardPlus(slug, hostFor(request, slug), await readJsonBody(request), {
      boards: getBoardRepository(),
      checkout: getCheckout(),
      policy,
      plusMode: getConfig().plusMode,
    });
    return NextResponse.json(result, { headers: JSON_HEADERS });
  } catch (error) {
    return plusErrorResponse(error, "Board Plus is not available right now. Please try again.");
  }
}
