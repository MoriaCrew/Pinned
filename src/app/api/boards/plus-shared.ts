import { NextResponse } from "next/server";
import { getConfig } from "../../../config";
import { getPolicy } from "../../../policy/server";
import type { Policy } from "../../../policy/policy";
import { BoardPlusError, hostOnlyError, type HostRouteDeps } from "../../../server/board-plus";
import { playerCookieName, readCookieValue } from "../../../server/board-session";
import { getBoardRepository } from "../../../server/board-repository";
import { hostTokenFrom } from "../../../server/host-session";
import { readJsonCapped, rateLimit, rejectCrossSite, requireJson } from "./request-guards";
import { JSON_HEADERS, errorResponse, notFound } from "./shared";

/** One per-IP budget shared by the skin and plus routes. */
const HOST_ROUTES_SCOPE = "board-host";

export type HostRouteGate =
  | { ok: true; hostToken: string | null; body: unknown }
  | { ok: false; response: NextResponse };

/**
 * Cheap gates for the skin and plus routes (PIN-103, PIN-181), in
 * order and all before any board read: cross-site 403 -> JSON 415
 * -> per-IP 429 -> body cap 413 -> a credential present 403: a
 * well-formed host cookie, or with `allowMember` (the skin route)
 * a board session cookie. Limits come from the env-level Policy
 * (the board is not loaded yet); the service then verifies the
 * credential against the board.
 */
export async function hostRouteGate(
  request: Request,
  slug: string,
  options: { allowMember?: boolean } = {},
): Promise<HostRouteGate> {
  const policy = getPolicy();
  const refused =
    rejectCrossSite(request) ??
    requireJson(request) ??
    rateLimit(request, HOST_ROUTES_SCOPE, policy.plus.hostRoutesPerIp);
  if (refused) return { ok: false, response: refused };
  const body = await readJsonCapped(request, policy.plus.requestMaxBytes);
  if (!body.ok) return { ok: false, response: body.response };
  const hostToken = hostTokenFrom(request, slug);
  const memberCookie = options.allowMember
    ? readCookieValue(request.headers.get("cookie"), playerCookieName(slug))
    : null;
  if (!hostToken && !memberCookie) {
    return { ok: false, response: plusErrorResponse(hostOnlyError(), "") };
  }
  return { ok: true, hostToken, body: body.value };
}

export function hostRouteDeps(policy: Policy): HostRouteDeps {
  return { boards: getBoardRepository(), policy, plusMode: getConfig().plusMode };
}

/**
 * BoardPlusError -> { error, code } with its 400/402/403 status
 * (404 stays the uniform body); everything else falls through to
 * the shared board-API mapping.
 */
export function plusErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof BoardPlusError) {
    if (error.status === 404) return notFound();
    return NextResponse.json(
      { error: error.message, ...(error.code ? { code: error.code } : {}) },
      { status: error.status, headers: JSON_HEADERS },
    );
  }
  return errorResponse(error, fallback);
}
