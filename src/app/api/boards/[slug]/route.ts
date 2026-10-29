import { NextResponse } from "next/server";
import { getConfig } from "../../../../config";
import type { Participant } from "../../../../domain/board";
import { getBoardView } from "../../../../server/board-api";
import {
  buildParticipantCookieHeader,
  restoreParticipantSession,
} from "../../../../server/board-session";
import {
  claimParticipantForUser,
  findClaimedParticipant,
} from "../../../../server/user-session";
import { claimDeps, currentUser } from "../../auth-shared";
import {
  JSON_HEADERS,
  boardApiDeps,
  errorResponse,
  isSecureRequest,
  notFound,
  policyForBoard,
  sessionDeps,
  slugGate,
  viewerFor,
} from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Board view for the polling board page (pinned pins are link-public).
 *
 * PIN-84, optional mode only (link-only never enters this branch,
 * so its response stays byte-identical): with a user session and
 * no participant cookie, a claimed participant is restored — a
 * fresh participant cookie is issued (slug was still required to
 * reach this route; sign-in never substitutes for the link).
 * With a participant cookie whose identity is unclaimed, opening
 * the board auto-claims it silently. A participant claimed by a
 * different user is left untouched; the explicit claim route is
 * where that conflict surfaces as 409. Any auth-side failure
 * degrades to the plain link-only view, never an error.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  try {
    const policy = await policyForBoard(slug);
    let viewer: Participant | null = await viewerFor(request, slug, policy);
    let restoredCookie: string | null = null;
    if (getConfig().authMode === "optional") {
      try {
        const user = await currentUser(request);
        if (user && !viewer) {
          const claimed = await findClaimedParticipant(slug, user, claimDeps());
          if (claimed) {
            const issued = await restoreParticipantSession(
              claimed,
              sessionDeps(policy),
            );
            viewer = issued.participant;
            restoredCookie = buildParticipantCookieHeader(
              slug,
              issued.cookieValue,
              issued.cookieExpiresAt,
              isSecureRequest(request),
            );
          }
        } else if (user && viewer && !viewer.userId) {
          viewer = await claimParticipantForUser(viewer, user, claimDeps());
        }
      } catch (error) {
        console.error("board auth restore failed", error);
      }
    }
    const view = await getBoardView(slug, viewer, boardApiDeps(policy));
    if (!view) return notFound();
    return NextResponse.json(view, {
      headers: restoredCookie
        ? { ...JSON_HEADERS, "Set-Cookie": restoredCookie }
        : JSON_HEADERS,
    });
  } catch (error) {
    return errorResponse(error, "Could not load this board. Please try again.");
  }
}
