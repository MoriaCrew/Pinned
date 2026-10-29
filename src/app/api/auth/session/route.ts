import { NextResponse } from "next/server";
import {
  checkRateLimit,
  clientKey,
  RATE_LIMITS,
} from "../../../../server/rate-limit";
import {
  buildClearUserCookieHeader,
  buildUserCookieHeader,
  establishUserSession,
  publicUser,
} from "../../../../server/user-session";
import { authDisabledGate, establishUserSessionDeps } from "../../auth-shared";
import { errorResponse, isSecureRequest, JSON_HEADERS } from "../../boards/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Exchange a Firebase ID token for the httpOnly user cookie. */
export async function POST(request: Request): Promise<NextResponse> {
  const gated = authDisabledGate();
  if (gated) return gated;
  const gate = RATE_LIMITS.authSessionPerIp;
  if (!checkRateLimit(clientKey(request, "auth-session"), gate.limit, gate.windowMs)) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a few minutes." },
      { status: 429, headers: JSON_HEADERS },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Send your sign-in token." },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  try {
    const result = await establishUserSession(body, establishUserSessionDeps());
    return NextResponse.json(
      { user: publicUser(result.user) },
      {
        headers: {
          ...JSON_HEADERS,
          "Set-Cookie": buildUserCookieHeader(
            result.cookieValue,
            result.cookieExpiresAt,
            isSecureRequest(request),
          ),
        },
      },
    );
  } catch (error) {
    return errorResponse(error, "Sign-in failed. Please try again.");
  }
}

/** Sign out: clear the user cookie (idempotent). */
export async function DELETE(request: Request): Promise<NextResponse> {
  const gated = authDisabledGate();
  if (gated) return gated;
  return NextResponse.json(
    { ok: true },
    {
      headers: {
        ...JSON_HEADERS,
        "Set-Cookie": buildClearUserCookieHeader(isSecureRequest(request)),
      },
    },
  );
}
