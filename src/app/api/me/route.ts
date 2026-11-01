import { NextResponse } from "next/server";
import { t } from "../../../i18n";
import { getLocale } from "../../../i18n/server";
import { publicUser } from "../../../server/user-session";
import { authDisabledGate, currentUser } from "../auth-shared";
import { errorResponse, JSON_HEADERS } from "../boards/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is signed in? 404 in link-only mode, 401 when signed out. */
export async function GET(request: Request): Promise<NextResponse> {
  const locale = await getLocale();
  const gated = authDisabledGate();
  if (gated) return gated;
  try {
    const user = await currentUser(request);
    if (!user) {
      return NextResponse.json(
        { error: t(locale, "request.notSignedIn") },
        { status: 401, headers: JSON_HEADERS },
      );
    }
    return NextResponse.json({ user: publicUser(user) }, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, t(locale, "request.checkSessionFailed"));
  }
}
