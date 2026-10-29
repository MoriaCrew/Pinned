import { NextResponse } from "next/server";
import { confirmPins } from "../../../../../../server/board-api";
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
 * "Pin N ->": { jobId, pinIds } pins the selected candidates,
 * drops the rest, and deletes the A6a working copy.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Choose which pins to keep." },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  try {
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    if (!viewer) {
      return NextResponse.json(
        { error: "Join this board before pinning." },
        { status: 401, headers: JSON_HEADERS },
      );
    }
    const result = await confirmPins(slug, viewer, body, boardApiDeps(policy));
    return NextResponse.json(result, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, "Those pins could not be saved. Please try again.");
  }
}
