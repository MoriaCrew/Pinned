import { NextResponse } from "next/server";
import { t } from "../../../../../i18n";
import { getLocale } from "../../../../../i18n/server";
import { getPolicy } from "../../../../../policy/server";
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
import { readJsonCapped } from "../../request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Gallery poll (link-public, non-hidden scenes only). */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const locale = await getLocale();
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  try {
    const policy = await policyForBoard(slug);
    const view = await getScenesView(slug, boardApiDeps(policy));
    if (!view) return notFound();
    return NextResponse.json(view, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, t(locale, "request.loadScenesFailed"));
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
  const locale = await getLocale();
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;

  const gate = RATE_LIMITS.submissionsPerIpGame;
  if (
    !checkRateLimit(`${clientKey(request, "scenes")}:${slug}`, gate.limit, gate.windowMs)
  ) {
    return NextResponse.json(
      { error: t(locale, "request.tooManyAttempts") },
      { status: 429, headers: JSON_HEADERS },
    );
  }

  // PIN-241: capped body read (413 past Policy.sceneRequestMaxBytes,
  // env-level Policy before any board read). Unparseable JSON reads
  // as null and keeps the old 400.
  const capped = await readJsonCapped(request, getPolicy().sceneRequestMaxBytes, locale);
  if (!capped.ok) return capped.response;
  if (capped.value === null) {
    return NextResponse.json(
      { error: t(locale, "request.pickPinsDescribe") },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  const body: unknown = capped.value;

  try {
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    if (!viewer) {
      return NextResponse.json(
        { error: t(locale, "request.joinBeforeScene") },
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
    return errorResponse(error, t(locale, "request.makeSceneFailed"));
  }
}
