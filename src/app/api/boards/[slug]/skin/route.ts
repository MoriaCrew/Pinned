import { NextResponse } from "next/server";
import { publicBoard } from "../../../../../server/board-api";
import { changeBoardSkin } from "../../../../../server/board-plus";
import { getBoardRepository } from "../../../../../server/board-repository";
import { hostFor, plusErrorResponse, readJsonBody } from "../../plus-shared";
import { JSON_HEADERS, slugGate } from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Change the board skin (PIN-103): { skinId } -> 200 { board }.
 * Bad slug 404 first; then host cookie (403, same for unknown
 * boards), unknown board 404, unknown skin 400, Plus skin without
 * the board's entitlement 402 { error, code: "plus_required" }.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  try {
    const board = await changeBoardSkin(slug, hostFor(request, slug), await readJsonBody(request), {
      boards: getBoardRepository(),
    });
    return NextResponse.json({ board: publicBoard(board) }, { headers: JSON_HEADERS });
  } catch (error) {
    return plusErrorResponse(error, "Could not change the skin. Please try again.");
  }
}
