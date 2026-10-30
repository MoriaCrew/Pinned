import { NextResponse } from "next/server";
import { deleteScene, getSceneView } from "../../../../../../server/board-api";
import { hostTokenFrom } from "../../../../../../server/host-session";
import { isSceneId } from "../../../../../../server/scene-job";
import { rejectCrossSite } from "../../../request-guards";
import {
  JSON_HEADERS,
  boardApiDeps,
  errorResponse,
  notFound,
  policyForBoard,
  slugGate,
  viewerFor,
} from "../../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scene status card poll. Every miss — bad slug, unknown scene,
 * another board's scene, a hidden scene — is the same 404.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string; sceneId: string }> },
): Promise<NextResponse> {
  const { slug, sceneId } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  try {
    const policy = await policyForBoard(slug);
    const view = await getSceneView(slug, sceneId, boardApiDeps(policy));
    if (!view) return notFound();
    return NextResponse.json(view, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, "Could not load this scene. Please try again.");
  }
}

/**
 * Delete a scene (PIN-142): its maker or the board host (the host
 * cookie's Path covers this route). Bodyless: no requireJson. The
 * cross-site 403 comes before any I/O; every other failure is the
 * uniform 404 (deleteScene's 404 -> notFound()). 204 on success/repeat.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ slug: string; sceneId: string }> },
): Promise<NextResponse> {
  const { slug, sceneId } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  if (!isSceneId(sceneId)) return notFound();
  try {
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    await deleteScene(slug, sceneId, viewer, { hostToken: hostTokenFrom(request, slug) }, boardApiDeps(policy));
    return new NextResponse(null, { status: 204, headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, "That scene could not be deleted. Please try again.");
  }
}
