import { NextResponse } from "next/server";
import {
  getScenesView,
  publicScene,
  publicSceneJob,
  requestScene,
} from "../../../../../server/board-api";
import {
  RATE_LIMITS,
  checkRateLimit,
  clientKey,
} from "../../../../../server/rate-limit";
import {
  JSON_HEADERS,
  boardApiDeps,
  errorResponse,
  notFound,
  policyForBoard,
  slugGate,
  viewerFor,
} from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Gallery poll (link-public, non-hidden scenes only). */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  try {
    const policy = await policyForBoard(slug);
    const view = await getScenesView(slug, boardApiDeps(policy));
    if (!view) return notFound();
    return NextResponse.json(view, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, "Could not load scenes. Please try again.");
  }
}

/**
 * Request a scene: runs its SceneJob in-request (docs/11 A4) and
 * returns the job + scene status card. A refused prompt is a 201
 * with status "refused" and a friendly line — never a 500.
 * Re-POSTing the same sceneId is idempotent (no second call).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;

  const gate = RATE_LIMITS.submissionsPerIpGame;
  if (
    !checkRateLimit(`${clientKey(request, "scenes")}:${slug}`, gate.limit, gate.windowMs)
  ) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a few minutes." },
      { status: 429, headers: JSON_HEADERS },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Pick some pins and describe your scene." },
      { status: 400, headers: JSON_HEADERS },
    );
  }

  try {
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    if (!viewer) {
      return NextResponse.json(
        { error: "Join this board before making a scene." },
        { status: 401, headers: JSON_HEADERS },
      );
    }
    const { job, scene } = await requestScene(
      slug,
      viewer,
      body,
      boardApiDeps(policy),
    );
    return NextResponse.json(
      { job: publicSceneJob(job), scene: publicScene(slug, scene) },
      { status: 201, headers: JSON_HEADERS },
    );
  } catch (error) {
    return errorResponse(error, "That scene could not be made. Please try again.");
  }
}
