import { NextResponse } from "next/server";
import { t } from "../../../../i18n";
import { getLocale } from "../../../../i18n/server";
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
import { rejectCrossSite, requireJson } from "../../boards/request-guards";
import { errorResponse, isSecureRequest, JSON_HEADERS } from "../../boards/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exchange a Firebase ID token for the httpOnly user cookie.
 * PIN-160 login-CSRF guard: a cross-site request (403) or a
 * non-JSON body (415, e.g. a text/plain form) is refused before
 * the rate limit and any body read, so another site cannot plant
 * its own session in a visitor's browser.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const locale = await getLocale();
  const gated = authDisabledGate();
  if (gated) return gated;
  const refused = rejectCrossSite(request, locale) ?? requireJson(request, locale);
  if (refused) return refused;
  const gate = RATE_LIMITS.authSessionPerIp;
  if (!checkRateLimit(clientKey(request, "auth-session"), gate.limit, gate.windowMs)) {
    return NextResponse.json(
      { error: t(locale, "request.tooManyAttempts") },
      { status: 429, headers: JSON_HEADERS },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: t(locale, "request.sendSignInToken") },
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
    return errorResponse(error, t(locale, "request.signInFailed"));
  }
}

/** Sign out: clear the user cookie (idempotent). */
export async function DELETE(request: Request): Promise<NextResponse> {
  const locale = await getLocale();
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
