import { NextResponse } from "next/server";
import { t } from "../../../../../i18n";
import { getLocale } from "../../../../../i18n/server";
import { getPolicy } from "../../../../../policy/server";
import { createReport } from "../../../../../server/board-report";
import { rateLimit, readJsonCapped, rejectCrossSite, requireJson } from "../../request-guards";
import {
  JSON_HEADERS,
  errorResponse,
  policyForBoard,
  reportDeps,
  slugGate,
  viewerFor,
} from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Report this board, a pin or a scene (PIN-270, ADR-004). Same-origin
 * JSON only, capped and rate-limited from the env-level Policy before
 * any board read. The request applies the hold itself and answers 201
 * with the opaque reference and whether anything was hidden; a bad
 * body is a typed 400, an unknown board or target the uniform 404.
 * Only POST exists: a GET never records anything (405).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const locale = await getLocale();
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  const crossSite = rejectCrossSite(request, locale);
  if (crossSite) return crossSite;
  const notJson = requireJson(request, locale);
  if (notJson) return notJson;
  const envPolicy = getPolicy();
  const limited = rateLimit(request, "report", envPolicy.report.perIp, locale);
  if (limited) return limited;
  const capped = await readJsonCapped(request, envPolicy.report.maxBytes, locale);
  if (!capped.ok) return capped.response;
  try {
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    const { record, held } = await createReport(slug, capped.value, viewer, reportDeps(policy));
    return NextResponse.json({ reference: record.reference, held }, { status: 201, headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, t(locale, "request.reportFailed"));
  }
}
