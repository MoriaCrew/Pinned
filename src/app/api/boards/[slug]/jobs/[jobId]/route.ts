import { NextResponse } from "next/server";
import { getJobView } from "../../../../../../server/board-api";
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
 * DecomposeJob poll (uploader-only). Every miss — bad slug, no
 * session, someone else's job, unknown job — is the same 404.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string; jobId: string }> },
): Promise<NextResponse> {
  const { slug, jobId } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  try {
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    const view = await getJobView(slug, jobId, viewer, boardApiDeps(policy));
    if (!view) return notFound();
    return NextResponse.json(view, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, "Could not load this job. Please try again.");
  }
}
