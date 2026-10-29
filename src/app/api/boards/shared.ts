import { NextResponse } from "next/server";
import { getConfig } from "../../../config";
import type { Participant } from "../../../domain/board";
import { isValidSlug } from "../../../domain/tokens";
import { getPolicy } from "../../../policy/server";
import type { Policy } from "../../../policy/policy";
import { getAiPorts } from "../../../server/ai-ports";
import type { BoardApiDeps } from "../../../server/board-api";
import { getBoardRepository } from "../../../server/board-repository";
import {
  BoardApiError,
  playerCookieName,
  readCookieValue,
  resolveParticipantSession,
  type BoardSessionDeps,
} from "../../../server/board-session";
import { getDecomposeJobStore } from "../../../server/decompose-job-store";
import { getSceneJobStore } from "../../../server/scene-job-store";
import { getChipsCacheStore } from "../../../server/chips-cache-store";
import { getDerivativeStore } from "../../../server/derivative-store";
import { PhotoIntakeError } from "../../../server/photo-intake";

export const JSON_HEADERS = { "Cache-Control": "no-store" };

/** The one uniform 404 body for every board-API miss (no existence leak). */
export function notFound(): NextResponse {
  return NextResponse.json(
    { error: "Not found." },
    { status: 404, headers: JSON_HEADERS },
  );
}

/**
 * Slug gate: called FIRST in every [slug] handler, before deps or
 * any repository read (docs/11 section 5.2: a %2F slug must never
 * reach Firestore as a path). Bad shape is a 404, never a 500.
 */
export function slugGate(slug: string): NextResponse | null {
  return isValidSlug(slug) ? null : notFound();
}

export function isSecureRequest(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return proto === "https" || new URL(request.url).protocol === "https:";
}

/** Policy for a board (env layer + the board's stored overrides). */
export async function policyForBoard(slug: string): Promise<Policy> {
  const board = await getBoardRepository().getBoard(slug);
  return getPolicy(board?.policyOverrides ?? null);
}

export function boardApiDeps(policy: Policy): BoardApiDeps {
  const ports = getAiPorts({ policy });
  return {
    boards: getBoardRepository(),
    jobs: getDecomposeJobStore(),
    store: getDerivativeStore(),
    namer: ports.elementNamer,
    segmenter: ports.segmenter,
    sceneJobs: getSceneJobStore(),
    ...(ports.sceneComposer ? { composer: ports.sceneComposer } : {}),
    ...(ports.chipSuggester ? { chipSuggester: ports.chipSuggester } : {}),
    chipsCache: getChipsCacheStore(),
    // PIN-71: under AI_MOCK the sharp collage composes scenes
    // offline; live mode keeps the port (over-budget -> collage).
    collageMode: getConfig().aiMock,
    policy,
  };
}

export function sessionDeps(policy: Policy): BoardSessionDeps {
  return {
    boards: getBoardRepository(),
    sessionSecret: getConfig().sessionSecret,
    policy,
  };
}

/** Cookie -> Participant for this board; null when not joined. */
export async function viewerFor(
  request: Request,
  slug: string,
  policy: Policy,
): Promise<Participant | null> {
  const cookie = readCookieValue(request.headers.get("cookie"), playerCookieName(slug));
  return resolveParticipantSession(slug, cookie, sessionDeps(policy));
}

/** Map service errors to responses; unknown errors become a generic 500. */
export function errorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof BoardApiError || error instanceof PhotoIntakeError) {
    if (error.status === 404) return notFound();
    return NextResponse.json(
      { error: error.message },
      { status: error.status, headers: JSON_HEADERS },
    );
  }
  console.error(fallback, error);
  return NextResponse.json(
    { error: fallback },
    { status: 500, headers: JSON_HEADERS },
  );
}
