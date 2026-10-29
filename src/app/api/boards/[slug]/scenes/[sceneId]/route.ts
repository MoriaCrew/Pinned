import { NextResponse } from "next/server";
import { getSceneView } from "../../../../../../server/board-api";
import {
  JSON_HEADERS,
  boardApiDeps,
  errorResponse,
  notFound,
  policyForBoard,
  slugGate,
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
