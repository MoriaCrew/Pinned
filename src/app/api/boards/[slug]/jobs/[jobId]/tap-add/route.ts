import { NextResponse } from "next/server";
import { t } from "../../../../../../../i18n";
import { getLocale } from "../../../../../../../i18n/server";
import { tapAddPin } from "../../../../../../../server/board-api";
import {
  JSON_HEADERS,
  boardApiDeps,
  errorResponse,
  notFound,
  policyForBoard,
  slugGate,
  viewerFor,
} from "../../../../shared";

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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: t(locale, "request.tapSpot") },
      { status: 400, headers: JSON_HEADERS },
    );
  }
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
