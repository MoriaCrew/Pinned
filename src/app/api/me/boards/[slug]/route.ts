import { NextResponse } from "next/server";
import { getPolicy } from "../../../../../policy/server";
import { getBoardRepository } from "../../../../../server/board-repository";
import { removeMyBoard } from "../../../../../server/my-boards";
import { getUserRepository } from "../../../../../server/user-repository";
import { authDisabledGate, currentUser } from "../../../auth-shared";
import { rateLimit, rejectCrossSite } from "../../../boards/request-guards";
import { errorResponse, JSON_HEADERS, slugGate } from "../../../boards/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Remove a board from My boards (PIN-166), for the caller only:
 * deletes users/{uid}/boards/{slug} and unlinks the caller's own
 * participant there (see removeMyBoard). Gates in order: link-only
 * 404, bad slug 404, cross-site 403 and the per-IP brake
 * (Policy.myBoardsRemovePerIp, 429) before any read, signed out
 * 401 like GET /api/me/boards. Success is always 204, whether or
 * not the caller had that board: no slug oracle.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const gated = authDisabledGate();
  if (gated) return gated;
  const { slug } = await context.params;
  const badSlug = slugGate(slug);
  if (badSlug) return badSlug;
  const refused =
    rejectCrossSite(request) ??
    rateLimit(request, "me-board-remove", getPolicy().myBoardsRemovePerIp);
  if (refused) return refused;
  try {
    const user = await currentUser(request);
    if (!user) {
      return NextResponse.json(
        { error: "Not signed in." },
        { status: 401, headers: JSON_HEADERS },
      );
    }
    await removeMyBoard(user, slug, {
      boards: getBoardRepository(),
      users: getUserRepository(),
    });
    return new NextResponse(null, { status: 204, headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, "Could not remove this board. Please try again.");
  }
}
