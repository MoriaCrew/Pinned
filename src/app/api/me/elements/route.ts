import { NextResponse } from "next/server";
import { getPolicy } from "../../../../policy/server";
import { getBoardRepository } from "../../../../server/board-repository";
import { listMyElements } from "../../../../server/my-pins";
import { getUserRepository } from "../../../../server/user-repository";
import { authDisabledGate, currentUser } from "../../auth-shared";
import { errorResponse, JSON_HEADERS } from "../../boards/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * My pins library (PIN-85): this signed-in user's elements
 * across every claimed board, newest first, capped at
 * Policy.libraryPageSize (an explicit ?limit= only ever
 * narrows it). Source boards appear as title labels only —
 * never slugs. 404 in link-only mode, 401 signed out.
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
    const rawLimit = new URL(request.url).searchParams.get("limit");
    const requested = rawLimit === null ? null : Number(rawLimit);
    const page = await listMyElements(
      user,
      {
        boards: getBoardRepository(),
        users: getUserRepository(),
        policy: getPolicy(),
      },
      requested,
    );
    return NextResponse.json(page, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, "Could not load your pins. Please try again.");
  }
}
