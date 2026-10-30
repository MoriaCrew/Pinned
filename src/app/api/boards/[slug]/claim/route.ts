import { NextResponse } from "next/server";
import { publicParticipant } from "../../../../../server/board-session";
import { getBoardRepository } from "../../../../../server/board-repository";
import {
  checkRateLimit,
  clientKey,
  RATE_LIMITS,
} from "../../../../../server/rate-limit";
import {
  claimParticipantForUser,
  publicUser,
} from "../../../../../server/user-session";
import {
  authDisabledGate,
  claimDeps,
  currentUserSession,
} from "../../../auth-shared";
import {
  errorResponse,
  JSON_HEADERS,
  notFound,
  policyForBoard,
  slugGate,
  viewerFor,
} from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Link this browser's board participant to the signed-in user
 * (PIN-83 claim flow). Needs both cookies: no user session ->
 * 401, not joined to the board -> 401, already claimed by a
 * different user -> 409. PIN-94: a stale sign-in (auth_time
 * outside the Policy fresh window) -> 401 stale_auth.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  const authGated = authDisabledGate();
  if (authGated) return authGated;
  const gate = RATE_LIMITS.authSessionPerIp;
  if (
    !checkRateLimit(`${clientKey(request, "claim")}:${slug}`, gate.limit, gate.windowMs)
  ) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a few minutes." },
      { status: 429, headers: JSON_HEADERS },
    );
  }
  try {
    const board = await getBoardRepository().getBoard(slug);
    if (!board) return notFound();
    const session = await currentUserSession(request);
    const user = session?.user ?? null;
    if (!user) {
      return NextResponse.json(
        { error: "Sign in to link this board." },
        { status: 401, headers: JSON_HEADERS },
      );
    }
    const policy = await policyForBoard(slug);
    const participant = await viewerFor(request, slug, policy);
    if (!participant) {
      return NextResponse.json(
        { error: "Join this board first." },
        { status: 401, headers: JSON_HEADERS },
      );
    }
    const claimed = await claimParticipantForUser(
      participant,
      user,
      claimDeps(session?.authTimeMs),
    );
    return NextResponse.json(
      {
        participant: publicParticipant(claimed),
        userId: user.uid,
        user: publicUser(user),
      },
      { headers: JSON_HEADERS },
    );
  } catch (error) {
    return errorResponse(error, "Could not link this board. Please try again.");
  }
}
