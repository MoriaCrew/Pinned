import { NextResponse } from "next/server";
import { t } from "../../../../i18n";
import { getLocale } from "../../../../i18n/server";
import { getConfig } from "../../../../config";
import type { Participant } from "../../../../domain/board";
import { getBoardView } from "../../../../server/board-api";
import {
  buildParticipantCookieHeader,
  restoreParticipantSession,
} from "../../../../server/board-session";
import {
  findClaimedParticipant,
  linkParticipantToUser,
} from "../../../../server/user-session";
import { claimDeps, currentUserSession } from "../../auth-shared";
import { getPolicy } from "../../../../policy/server";
import { deleteBoardForEveryone } from "../../../../server/board-delete";
import { getBoardRepository } from "../../../../server/board-repository";
import { BoardApiError } from "../../../../server/board-session";
import { getDerivativeStore } from "../../../../server/derivative-store";
import { hostTokenFrom } from "../../../../server/host-session";
import { getUserRepository } from "../../../../server/user-repository";
import { logServerError } from "../../../../server/safe-log";
import { isCrossSite, rateLimit, rejectCrossSite } from "../request-guards";
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
 * PIN-94: restore additionally needs a fresh sign-in (auth_time
 * inside the Policy window); a stale session restores nobody and
 * gets the plain view, exactly like a signed-out one. PIN-160:
 * the auto-claim does not — this browser already holds both the
 * board's participant cookie and the user cookie. Neither runs
 * for a request the browser labels cross-site (a top-level
 * navigation from another site must not write or rotate
 * anything); the app's own poll is a same-origin fetch. PIN-167:
 * the board is loaded first, so a missing or deleted board is the
 * 404 before that branch can restore or link anything.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const locale = await getLocale();
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  try {
    const board = await getBoardRepository().getBoard(slug);
    if (!board) return notFound();
    const policy = getPolicy(board.policyOverrides ?? null);
    let viewer: Participant | null = await viewerFor(request, slug, policy);
    let restoredCookie: string | null = null;
    if (getConfig().authMode === "optional" && !isCrossSite(request)) {
      try {
        const session = await currentUserSession(request);
        const user = session?.user ?? null;
        const deps = claimDeps(session?.authTimeMs);
        if (user && !viewer) {
          const claimed = await findClaimedParticipant(slug, user, deps);
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
          viewer = await linkParticipantToUser(viewer, user, deps);
        }
      } catch (error) {
        logServerError("board auth restore failed", error);
      }
    }
    // PIN-103: additive viewer.isHost + plus. The host cookie is
    // Path-scoped to /api/boards/<slug>, so it reaches this route.
    const view = await getBoardView(slug, viewer, boardApiDeps(policy), {
      hostToken: hostTokenFrom(request, slug),
    });
    if (!view) return notFound();
    return NextResponse.json(view, {
      headers: restoredCookie
        ? { ...JSON_HEADERS, "Set-Cookie": restoredCookie }
        : JSON_HEADERS,
    });
  } catch (error) {
    return errorResponse(error, t(locale, "request.loadBoardFailed"));
  }
}

/**
 * Delete this board for everyone (PIN-167): the host only, by the
 * host cookie (its Path covers this route). Bodyless: no
 * requireJson. Bad slug 404, then cross-site 403 and the
 * Policy.boardDeletePerIp brake 429 before any read. After that
 * every failure — no or bad host cookie, another board's host, an
 * unknown or already deleted board — is the one uniform 404, never
 * the Plus routes' 403. 204 on success.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const locale = await getLocale();
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  const refused =
    rejectCrossSite(request, locale) ??
    rateLimit(request, "board-delete", getPolicy().boardDeletePerIp, locale);
  if (refused) return refused;
  const hostToken = hostTokenFrom(request, slug);
  if (!hostToken) return notFound();
  try {
    await deleteBoardForEveryone(slug, hostToken, {
      boards: getBoardRepository(),
      users: getUserRepository(),
      store: getDerivativeStore(),
      policy: await policyForBoard(slug),
    });
    return new NextResponse(null, { status: 204, headers: JSON_HEADERS });
  } catch (error) {
    if (error instanceof BoardApiError && error.status === 404) return notFound();
    // By error name only: a store error can carry the slug or a uid.
    console.error("Board delete failed.", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json(
      { error: t(locale, "request.deleteBoardFailed") },
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
