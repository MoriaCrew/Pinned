import { NextResponse } from "next/server";
import { getConfig } from "../../../../config";
import { getBoardRepository } from "../../../../server/board-repository";
import { listMyBoards } from "../../../../server/my-boards";
import { getUserRepository } from "../../../../server/user-repository";
import { authDisabledGate, currentUser } from "../../auth-shared";
import { errorResponse, JSON_HEADERS } from "../../boards/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * My boards (PIN-84): boards this signed-in user has claimed,
 * newest activity first. 404 in link-only mode, 401 signed out.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const gated = authDisabledGate();
  if (gated) return gated;
  try {
    const user = await currentUser(request);
    if (!user) {
      return NextResponse.json(
        { error: "Not signed in." },
        { status: 401, headers: JSON_HEADERS },
      );
    }
    const boards = await listMyBoards(user, {
      boards: getBoardRepository(),
      users: getUserRepository(),
      plusMode: getConfig().plusMode,
    });
    return NextResponse.json({ boards }, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, "Could not load your boards. Please try again.");
  }
}
