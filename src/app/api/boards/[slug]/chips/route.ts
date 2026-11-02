import { NextResponse } from "next/server";
import { t } from "../../../../../i18n";
import { getLocale } from "../../../../../i18n/server";
import { getPolicy } from "../../../../../policy/server";
import { getSceneChips } from "../../../../../server/board-api";
import {
  RATE_LIMITS,
  checkRateLimit,
  clientKey,
} from "../../../../../server/rate-limit";
import {
  JSON_HEADERS,
  boardApiDeps,
  errorResponse,
  policyForBoard,
  slugGate,
  viewerFor,
} from "../../shared";
import { readJsonCapped } from "../../request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Suggestion chips for the picked pins (PIN-75): cache-first, then
 * one decorated Spark call, then the fixed idea chips, all in the
 * request's UI language (PIN-214). The Make sheet already shows the
 * fixed chips, so every AI outcome here is a 200 — chips never
 * block or break making a scene.
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
    !checkRateLimit(`${clientKey(request, "chips")}:${slug}`, gate.limit, gate.windowMs)
  ) {
    return NextResponse.json(
      { error: t(locale, "request.tooManyAttempts") },
      { status: 429, headers: JSON_HEADERS },
    );
  }

  // PIN-241: capped body read (413 past Policy.chipsRequestMaxBytes,
  // env-level Policy before any board read). Unparseable JSON reads
  // as null and keeps the old 400.
  const capped = await readJsonCapped(request, getPolicy().chipsRequestMaxBytes, locale);
  if (!capped.ok) return capped.response;
  if (capped.value === null) {
    return NextResponse.json(
      { error: t(locale, "request.pickPinsFirst") },
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
    const result = await getSceneChips(slug, viewer, body, boardApiDeps(policy), locale);
    return NextResponse.json(result, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, t(locale, "request.ideasFailed"));
  }
}
