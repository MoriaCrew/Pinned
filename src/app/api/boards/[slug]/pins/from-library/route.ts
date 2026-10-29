import { NextResponse } from "next/server";
import { publicPin } from "../../../../../../server/board-api";
import { getBoardRepository } from "../../../../../../server/board-repository";
import {
  parsePinFromLibraryInput,
  pinFromLibrary,
} from "../../../../../../server/my-pins";
import { getUserRepository } from "../../../../../../server/user-repository";
import { authDisabledGate, currentUser } from "../../../../auth-shared";
import {
  errorResponse,
  JSON_HEADERS,
  policyForBoard,
  slugGate,
  viewerFor,
} from "../../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pin one of my library elements onto this board (PIN-85):
 * { elementId }. Needs BOTH cookies — the signed-in user (the
 * library is theirs; ownership is re-checked in the service)
 * and a participant on this board (the pin is theirs here).
 * Cross-board elements land as a provenance copy (see
 * server/my-pins). Pinning twice is a friendly
 * { alreadyPinned: true }, never an error. 404 in link-only
 * mode; signed out or not joined -> 401; another user's or an
 * unknown element -> the uniform 404.
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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Pick a pin from your library." },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  try {
    const user = await currentUser(request);
    if (!user) {
      return NextResponse.json(
        { error: "Sign in to use your library." },
        { status: 401, headers: JSON_HEADERS },
      );
    }
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    if (!viewer) {
      return NextResponse.json(
        { error: "Join this board before pinning." },
        { status: 401, headers: JSON_HEADERS },
      );
    }
    const { elementId } = parsePinFromLibraryInput(body);
    const result = await pinFromLibrary(slug, viewer, user, elementId, {
      boards: getBoardRepository(),
      users: getUserRepository(),
      policy,
    });
    return NextResponse.json(
      {
        alreadyPinned: result.alreadyPinned,
        elementId: result.elementId,
        pin: publicPin(result.pin),
      },
      { headers: JSON_HEADERS },
    );
  } catch (error) {
    return errorResponse(error, "That pin could not be added. Please try again.");
  }
}
