import { NextResponse } from "next/server";
import {
  buildParticipantCookieHeader,
  joinBoard,
  playerCookieName,
  publicParticipant,
  readCookieValue,
} from "../../../../../server/board-session";
import { RATE_LIMITS, checkRateLimit, clientKey } from "../../../../../server/rate-limit";
import {
  JSON_HEADERS,
  errorResponse,
  isSecureRequest,
  policyForBoard,
  sessionDeps,
  slugGate,
  viewerFor,
} from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who am I on this board? { participant: null } when not joined. */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  try {
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    return NextResponse.json(
      { participant: viewer ? publicParticipant(viewer) : null },
      { headers: JSON_HEADERS },
    );
  } catch (error) {
    return errorResponse(error, "Could not check your session. Please try again.");
  }
}

/** Join (or rename/reclaim) with { displayName, reclaimPin? }; sets the cookie. */
export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  const gate = RATE_LIMITS.playersPerIpGame;
  if (!checkRateLimit(`${clientKey(request, "participants")}:${slug}`, gate.limit, gate.windowMs)) {
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
      { error: "Send your display name." },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  try {
    const policy = await policyForBoard(slug);
    const existingCookie = readCookieValue(
      request.headers.get("cookie"),
      playerCookieName(slug),
    );
    const result = await joinBoard(slug, body, existingCookie, sessionDeps(policy));
    return NextResponse.json(
      { participant: publicParticipant(result.participant), outcome: result.outcome },
      {
        status: result.outcome === "created" ? 201 : 200,
        headers: {
          ...JSON_HEADERS,
          "Set-Cookie": buildParticipantCookieHeader(
            slug,
            result.cookieValue,
            result.cookieExpiresAt,
            isSecureRequest(request),
          ),
        },
      },
    );
  } catch (error) {
    return errorResponse(error, "Could not join this board. Please try again.");
  }
}
