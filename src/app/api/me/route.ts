import { NextResponse } from "next/server";
import { publicUser } from "../../../server/user-session";
import { authDisabledGate, currentUser } from "../auth-shared";
import { errorResponse, JSON_HEADERS } from "../boards/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is signed in? 404 in link-only mode, 401 when signed out. */
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
    return NextResponse.json({ user: publicUser(user) }, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, "Could not check your session. Please try again.");
  }
}
