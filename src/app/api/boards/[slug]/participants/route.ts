import { NextResponse } from "next/server";
import {
  buildParticipantCookieHeader,
  joinBoard,
  playerCookieName,
  publicParticipant,
  readCookieValue,
} from "../../../../../server/board-session";
import {
  RATE_LIMITS,
  checkRateLimit,
  clientIp,
  clientKey,
} from "../../../../../server/rate-limit";
import { getConfig } from "../../../../../config";
import { linkParticipantOnJoin } from "../../../../../server/user-session";
import { claimDeps, currentUserSession } from "../../../auth-shared";
import { logServerError } from "../../../../../server/safe-log";
import { rejectCrossSite, requireJson } from "../../request-guards";
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

/**
 * Join (or rename/reclaim) with { displayName, reclaimPin? }; sets the cookie.
 * PIN-160 CSRF guard: a cross-site request (403) or a non-JSON body
 * (415, e.g. a text/plain form) is refused before the rate limit and
 * any body read, so another site cannot set an attacker-known
 * participant cookie that a signed-in board open would then link.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  const refused = rejectCrossSite(request) ?? requireJson(request);
  if (refused) return refused;
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
    const result = await joinBoard(slug, body, existingCookie, sessionDeps(policy), {
      clientIp: clientIp(request),
    });
    // PIN-83: join-while-signed-in auto-links the participant to
    // the user + board index. Optional-mode only and best-effort:
    // link-only never runs this, and a link failure never fails
    // the join (the explicit claim route surfaces real errors).
    // PIN-160: any sign-in age links (this browser holds both
    // cookies); freshness gates only the claim route and restore.
    let participant = result.participant;
    if (getConfig().authMode === "optional") {
      try {
        const session = await currentUserSession(request);
        if (session) {
          participant = await linkParticipantOnJoin(
            participant,
            session.user,
            claimDeps(session.authTimeMs),
          );
        }
      } catch (error) {
        logServerError("join auto-link failed", error);
      }
    }
    return NextResponse.json(
      { participant: publicParticipant(participant), outcome: result.outcome },
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
