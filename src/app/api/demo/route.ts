import { NextResponse } from "next/server";
import { getConfig } from "../../../config";
import { landingHrefWithDemoNotice } from "../../../domain/demo-ui";
import { makerKey } from "../../../domain/maker-key";
import { t } from "../../../i18n";
import { getLocale } from "../../../i18n/server";
import { getPolicy } from "../../../policy/server";
import { BoardApiError } from "../../../server/board-session";
import { DEMO_CAPPED, createDemoBoard } from "../../../server/demo-board";
import { buildHostCookieHeader, hostCookieMaxAgeSeconds } from "../../../server/host-session";
import { checkRateLimit, clientIp, clientKey } from "../../../server/rate-limit";
import { logServerError } from "../../../server/safe-log";
import { getUserRepository } from "../../../server/user-repository";
import { rejectCrossSite } from "../boards/request-guards";
import { JSON_HEADERS, boardApiDeps, isSecureRequest } from "../boards/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A form post's answer: a redirect, relative so no origin is ever guessed. */
function seeOther(location: string, headers: Record<string, string> = {}): NextResponse {
  return new NextResponse(null, { status: 303, headers: { ...JSON_HEADERS, Location: location, ...headers } });
}

/**
 * "See a board" (PIN-251): the landing's same-origin form posts here
 * and the visitor lands on a fresh demo board of their own, with the
 * host cookie (they may delete it). Only POST exists: a GET, a
 * prefetch or a crawler never creates anything. A cross-site post is
 * the uniform 403; a cap or a failure sends the visitor back to the
 * landing with a one-line notice, never a JSON page.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const locale = await getLocale();
  const crossSite = rejectCrossSite(request, locale);
  if (crossSite) return crossSite;
  const policy = getPolicy();
  const brake = policy.demo.createPerIp;
  if (!checkRateLimit(clientKey(request, "demo-create"), brake.limit, brake.windowMs)) {
    return seeOther(landingHrefWithDemoNotice("busy"));
  }
  const templateSlug = getConfig().demoBoardSlug;
  if (!templateSlug) return seeOther(landingHrefWithDemoNotice("unavailable"));
  try {
    const { board, hostToken } = await createDemoBoard(
      {
        templateSlug,
        title: t(locale, "landing.demoTitle"),
        // The same hashing as the maker rule, under the demo's own key prefix.
        clientKey: makerKey({ clientIp: clientIp(request) }),
      },
      { ...boardApiDeps(policy), users: getUserRepository() },
    );
    const hostCookie = buildHostCookieHeader(
      board.slug,
      hostToken,
      hostCookieMaxAgeSeconds(policy),
      isSecureRequest(request),
    );
    return seeOther(`/g/${board.slug}`, { "Set-Cookie": hostCookie });
  } catch (error) {
    if (error instanceof BoardApiError && error.code === DEMO_CAPPED) {
      return seeOther(landingHrefWithDemoNotice("busy"));
    }
    if (!(error instanceof BoardApiError)) logServerError("demo board creation failed", error);
    return seeOther(landingHrefWithDemoNotice("unavailable"));
  }
}
