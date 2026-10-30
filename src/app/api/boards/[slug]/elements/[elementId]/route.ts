import { NextResponse } from "next/server";
import { getPolicy } from "../../../../../../policy/server";
import { deleteMyElement, renameMyElement } from "../../../../../../server/board-api";
import { readJsonCapped, rejectCrossSite, requireJson } from "../../../request-guards";
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

/**
 * Rename my element (PIN-156): JSON { label } -> 200 { element }, the
 * board view's public element. Bad slug 404; then the guards, none of
 * which reads anything, so they answer the same for any element:
 * cross-site 403, non-JSON 415, body over Policy.elementRenameMaxBytes
 * 413 (env-level Policy, as plus-shared.ts). Then the owner gate in
 * renameMyElement (every miss the uniform 404), and only then the
 * label rule (400).
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ slug: string; elementId: string }> },
): Promise<NextResponse> {
  const { slug, elementId } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  try {
    const refused = rejectCrossSite(request) ?? requireJson(request);
    if (refused) return refused;
    const body = await readJsonCapped(request, getPolicy().elementRenameMaxBytes);
    if (!body.ok) return body.response;
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    const result = await renameMyElement(slug, viewer, elementId, body.value, boardApiDeps(policy));
    return NextResponse.json(result, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, "That thing could not be renamed. Please try again.");
  }
}
