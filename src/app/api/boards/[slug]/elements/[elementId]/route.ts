import { NextResponse } from "next/server";
import { deleteMyElement } from "../../../../../../server/board-api";
import {
  JSON_HEADERS,
  boardApiDeps,
  errorResponse,
  policyForBoard,
  slugGate,
  viewerFor,
} from "../../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Delete my element (PIN-77): owner-only via the participant
 * cookie. Every miss — bad slug, unknown board/element, an
 * element from another board, a non-owner, or no cookie at
 * all — is the one uniform 404 (errorResponse maps the
 * service's 404 BoardApiError to notFound()), so a re-delete
 * is also that 404 with state unchanged.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ slug: string; elementId: string }> },
): Promise<NextResponse> {
  const { slug, elementId } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  try {
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    const result = await deleteMyElement(slug, viewer, elementId, boardApiDeps(policy));
    return NextResponse.json(result, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, "That pin could not be deleted. Please try again.");
  }
}
