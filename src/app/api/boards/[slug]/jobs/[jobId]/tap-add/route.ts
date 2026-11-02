import { NextResponse } from "next/server";
import { t } from "../../../../../../../i18n";
import { getLocale } from "../../../../../../../i18n/server";
import { getPolicy } from "../../../../../../../policy/server";
import { tapAddPin } from "../../../../../../../server/board-api";
import {
  RATE_LIMITS,
  checkRateLimit,
  clientKey,
} from "../../../../../../../server/rate-limit";
import {
  JSON_HEADERS,
  boardApiDeps,
  errorResponse,
  notFound,
  policyForBoard,
  slugGate,
  viewerFor,
} from "../../../../shared";
import { readJsonCapped } from "../../../../request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tap-to-add (PIN-78): { x, y } normalized 0..1 on the photo ->
 * Segmenter point prompt on the job's working copy -> a new
 * candidate pin on the same job. Uploader-only; every miss —
 * bad slug, no session, someone else's job, unknown job — is
 * the same 404.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string; jobId: string }> },
): Promise<NextResponse> {
  const locale = await getLocale();
  const { slug, jobId } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  // PIN-241: the same per-IP+board brake scenes/chips use; tap-add
  // is a paid Segmenter entry point and had none.
  const gate = RATE_LIMITS.submissionsPerIpGame;
  if (
    !checkRateLimit(`${clientKey(request, "tap-add")}:${slug}`, gate.limit, gate.windowMs)
  ) {
    return NextResponse.json(
      { error: t(locale, "request.tooManyAttempts") },
      { status: 429, headers: JSON_HEADERS },
    );
  }
  // PIN-241: capped body read (413 past Policy.tapAddMaxBytes,
  // env-level Policy before any board read). Unparseable JSON reads
  // as null and keeps the old 400.
  const capped = await readJsonCapped(request, getPolicy().tapAddMaxBytes, locale);
  if (!capped.ok) return capped.response;
  if (capped.value === null) {
    return NextResponse.json(
      { error: t(locale, "request.tapSpot") },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  const body: unknown = capped.value;
  try {
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    if (!viewer) return notFound();
    const result = await tapAddPin(slug, viewer, jobId, body, boardApiDeps(policy));
    return NextResponse.json(result, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, t(locale, "request.addTapFailed"));
  }
}
