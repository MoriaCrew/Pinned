import { NextResponse } from "next/server";
import { getConfig } from "../../../config";
import type { Participant } from "../../../domain/board";
import { isValidSlug } from "../../../domain/tokens";
import { DEFAULT_LOCALE } from "../../../i18n";
import { getLocale } from "../../../i18n/server";
import { localizedErrorText, type LocalizableError } from "../../../i18n/user-message";
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
import { CREDITS_POOL_EMPTY } from "../../../server/credit-pool";
import { getCreditLedgerStore } from "../../../server/credit-ledger-store";
import { PhotoIntakeError } from "../../../server/photo-intake";
import { logServerError } from "../../../server/safe-log";

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
    ...(ports.tapNamer ? { tapNamer: ports.tapNamer } : {}),
    chipsCache: getChipsCacheStore(),
    // PIN-71: under AI_MOCK the sharp collage composes scenes
    // offline; live mode keeps the port (over-budget -> collage).
    collageMode: getConfig().aiMock,
    // PIN-103: which Plus grants count + the view's Plus offer.
    plusMode: getConfig().plusMode,
    // PIN-151: the makes ledger; inert until Policy.credits.enabled.
    credits: getCreditLedgerStore(),
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

/**
 * `{ error, ...extra }` with the error's line in the request's
 * language (PIN-196). Sync on purpose, so no call site changes
 * (some helpers are typed `NextResponse`). With English only (the
 * default) the body is built right away, as before. Otherwise the
 * body is a one-chunk stream that waits for getLocale(): the
 * stream's start() runs inside this call, so getLocale() reads this
 * request's cookie and headers. If that fails, the English text.
 */
export function localizedErrorJson(
  error: LocalizableError,
  status: number,
  extra: Readonly<Record<string, string>> = {},
): NextResponse {
  if (!error.userMessage || getConfig().uiLocales.length <= 1) {
    return NextResponse.json({ error: error.message, ...extra }, { status, headers: JSON_HEADERS });
  }
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let text = localizedErrorText(error, DEFAULT_LOCALE);
      try {
        text = localizedErrorText(error, await getLocale());
      } catch {
        // Keep English: a language lookup must never turn a 4xx into a 500.
      }
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: text, ...extra })));
      controller.close();
    },
  });
  return new NextResponse(body, {
    status,
    headers: { ...JSON_HEADERS, "Content-Type": "application/json" },
  });
}

/** Map service errors to responses; unknown errors become a generic 500. */
export function errorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof BoardApiError || error instanceof PhotoIntakeError) {
    if (error.status === 404) return notFound();
    // The empty-pool 429 carries its typed code (docs/15; PIN-183): the Add sheet
    // tells it from a rate limit by it and offers Plus. Other bodies stay as they are.
    const poolEmpty = error instanceof BoardApiError && error.code === CREDITS_POOL_EMPTY;
    return localizedErrorJson(error, error.status, poolEmpty ? { code: CREDITS_POOL_EMPTY } : {});
  }
  logServerError(fallback, error);
  return NextResponse.json(
    { error: fallback },
    { status: 500, headers: JSON_HEADERS },
  );
}
