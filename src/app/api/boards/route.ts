import { NextResponse } from "next/server";
import { t } from "../../../i18n";
import { getLocale } from "../../../i18n/server";
import { getPolicy } from "../../../policy/server";
import { createBoardWithHost, publicBoard } from "../../../server/board-api";
import { buildHostCookieHeader, hostCookieMaxAgeSeconds } from "../../../server/host-session";
import { requestMakerKey } from "../../../server/maker-context";
import { checkRateLimit, clientKey } from "../../../server/rate-limit";
import { signedInUserId } from "../auth-shared";
import { plusErrorResponse } from "./plus-shared";
import { JSON_HEADERS, boardApiDeps, isSecureRequest } from "./shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a board: { title, themeId? } -> 201 { board } with its slug link.
 * PIN-103: also sets the host cookie (this browser is the host),
 * scoped to Path=/api/boards/<slug>; the board stores only the
 * token's hash. A Plus skin as the initial theme is a 402.
 * PIN-205: while credits are on, the maker (signed-in user, else
 * client address) decides whether the board gets the free pool.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const locale = await getLocale();
  const gate = getPolicy().boardCreatePerIp;
  if (!checkRateLimit(clientKey(request, "board-create"), gate.limit, gate.windowMs)) {
    return NextResponse.json(
      { error: t(locale, "request.tooManyBoards") },
      { status: 429, headers: JSON_HEADERS },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: t(locale, "request.giveTitle") },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  try {
    const policy = getPolicy();
    const context = policy.credits.enabled
      ? { makerKey: await requestMakerKey(request, signedInUserId) }
      : undefined;
    const { board, hostToken } = await createBoardWithHost(body, boardApiDeps(policy), context);
    const hostCookie = buildHostCookieHeader(
      board.slug,
      hostToken,
      hostCookieMaxAgeSeconds(policy),
      isSecureRequest(request),
    );
    return NextResponse.json(
      { board: publicBoard(board) },
      { status: 201, headers: { ...JSON_HEADERS, "Set-Cookie": hostCookie } },
    );
  } catch (error) {
    return plusErrorResponse(error, t(locale, "request.createBoardFailed"));
  }
}
