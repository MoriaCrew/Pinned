import { NextResponse } from "next/server";
import { getConfig } from "../../../config";
import { getLocale } from "../../../i18n/server";
import { getPolicy } from "../../../policy/server";
import type { Policy } from "../../../policy/policy";
import { BoardPlusError, hostOnlyError, type HostRouteDeps } from "../../../server/board-plus";
import { getBoardRepository } from "../../../server/board-repository";
import { hostTokenFrom } from "../../../server/host-session";
import { readJsonCapped, rateLimit, rejectCrossSite, requireJson } from "./request-guards";
import { JSON_HEADERS, errorResponse, notFound } from "./shared";

/** One per-IP budget shared by the two host-only routes. */
const HOST_ROUTES_SCOPE = "board-host";

export type HostRouteGate =
  | { ok: true; hostToken: string; body: unknown }
  | { ok: false; response: NextResponse };

/**
 * Cheap gates for the host-only routes (PIN-103), in order and all
 * before any board read: cross-site 403 -> JSON 415 -> per-IP 429
 * -> host cookie present and well-formed 403 -> body cap 413.
 * Limits come from the env-level Policy (the board is not loaded
 * yet); the service then verifies the token against the board.
 */
export async function hostRouteGate(request: Request, slug: string): Promise<HostRouteGate> {
  const locale = await getLocale();
  const policy = getPolicy();
  const refused =
    rejectCrossSite(request, locale) ??
    requireJson(request, locale) ??
    rateLimit(request, HOST_ROUTES_SCOPE, policy.plus.hostRoutesPerIp, locale);
  if (refused) return { ok: false, response: refused };
  const hostToken = hostTokenFrom(request, slug);
  if (!hostToken) return { ok: false, response: plusErrorResponse(hostOnlyError(), "") };
  const body = await readJsonCapped(request, policy.plus.requestMaxBytes, locale);
  if (!body.ok) return { ok: false, response: body.response };
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
