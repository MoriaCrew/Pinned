import { NextResponse } from "next/server";
import { t, type Locale, type MessageKey } from "../../../i18n";
import { checkRateLimit, clientKey } from "../../../server/rate-limit";
import { JSON_HEADERS } from "./shared";

/**
 * Request guards for state-changing JSON routes (PIN-103). Opt-in:
 * each returns a ready error response or null, so a route chains
 * the ones it needs before any I/O. Today only the host-only Plus
 * routes use them; other routes can adopt them one by one.
 * Bodies are `{ error, code }` like the rest of the board API.
 */
function refuse(
  locale: Locale,
  status: number,
  key: MessageKey,
  code: string,
): NextResponse {
  return NextResponse.json({ error: t(locale, key), code }, { status, headers: JSON_HEADERS });
}

/**
 * True when a browser labels the request anything but same-origin.
 * Clients that send no Sec-Fetch-Site (old browsers, scripts) are
 * not cross-site here; requireJson and the SameSite=Lax cookie
 * remain the other layers.
 */
export function isCrossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin";
}

/** Fetch-metadata CSRF check: a cross-site request is refused (403). */
export function rejectCrossSite(request: Request, locale: Locale): NextResponse | null {
  return isCrossSite(request) ? refuse(locale, 403, "request.crossSite", "cross_site") : null;
}

/**
 * 415 unless the body is declared JSON. A cross-site HTML form
 * cannot send application/json, and a cross-site fetch that does
 * needs a CORS preflight this API never grants.
 */
export function requireJson(request: Request, locale: Locale): NextResponse | null {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return type === "application/json" ? null : refuse(locale, 415, "request.json", "unsupported_media_type");
}

/** Per-IP brake through the shared in-process rate limiter (429). */
export function rateLimit(
  request: Request,
  scope: string,
  budget: { limit: number; windowMs: number },
  locale: Locale,
): NextResponse | null {
  return checkRateLimit(clientKey(request, scope), budget.limit, budget.windowMs)
    ? null
    : refuse(locale, 429, "request.rateLimited", "rate_limited");
}

export type CappedJson = { ok: true; value: unknown } | { ok: false; response: NextResponse };

/**
 * Read a JSON body of at most `maxBytes` (413 when the declared
 * length or the streamed bytes exceed it — reading stops there).
 * Unparseable or empty JSON is `value: null`: the service then
 * answers its own 400 for missing input.
 */
export async function readJsonCapped(
  request: Request,
  maxBytes: number,
  locale: Locale,
): Promise<CappedJson> {
  const tooLarge = (): CappedJson => ({
    ok: false,
    response: refuse(locale, 413, "request.tooLarge", "body_too_large"),
  });
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
  if (!request.body) return { ok: true, value: null };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return tooLarge();
    }
    chunks.push(value);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: true, value: null };
  }
}
