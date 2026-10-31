import { NextResponse } from "next/server";
import { t } from "../../../../../i18n";
import { getLocale } from "../../../../../i18n/server";
import { publicBoard } from "../../../../../server/board-api";
import { changeBoardSkin } from "../../../../../server/board-plus";
import { hostRouteDeps, hostRouteGate, plusErrorResponse } from "../../plus-shared";
import { JSON_HEADERS, policyForBoard, slugGate } from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Change the board skin (PIN-103): JSON { skinId } -> 200 { board }.
 * Bad slug 404; then the I/O-free gates (cross-site 403, non-JSON
 * 415, per-IP 429, missing/malformed host cookie 403, body over
 * Policy 413); then host token vs the board's stored hash + age
 * (403, unknown boards too), unknown skin 400, Plus skin without an
 * entitlement that counts 402 { error, code: "plus_required" }.
 * Choosing the current skin is a no-op 200 (no write).
 */
export async function PATCH(
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
    const board = await changeBoardSkin(slug, gate.hostToken, gate.body, hostRouteDeps(policy));
    return NextResponse.json({ board: publicBoard(board) }, { headers: JSON_HEADERS });
  } catch (error) {
    return plusErrorResponse(error, t(locale, "request.changeSkinFailed"));
  }
}
