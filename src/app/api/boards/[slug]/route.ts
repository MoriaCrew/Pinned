import { NextResponse } from "next/server";
import { getBoardView } from "../../../../server/board-api";
import {
  JSON_HEADERS,
  boardApiDeps,
  errorResponse,
  notFound,
  policyForBoard,
  slugGate,
  viewerFor,
} from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Board view for the polling board page (pinned pins are link-public). */
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
    const view = await getBoardView(slug, viewer, boardApiDeps(policy));
    if (!view) return notFound();
    return NextResponse.json(view, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, "Could not load this board. Please try again.");
  }
}
