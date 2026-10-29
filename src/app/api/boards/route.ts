import { NextResponse } from "next/server";
import { getConfig } from "../../../config";
import { getPolicy } from "../../../policy/server";
import { createBoard, publicBoard } from "../../../server/board-api";
import { issueHostCookie } from "../../../server/host-session";
import { RATE_LIMITS, checkRateLimit, clientKey } from "../../../server/rate-limit";
import { plusErrorResponse } from "./plus-shared";
import { JSON_HEADERS, boardApiDeps, isSecureRequest } from "./shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a board: { title, themeId? } -> 201 { board } with its slug link.
 * PIN-103: also sets the per-board host cookie (this browser is the
 * host) when sessions are configured; a Plus skin here is a 402.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const gate = RATE_LIMITS.boardCreatePerIp;
  if (!checkRateLimit(clientKey(request, "board-create"), gate.limit, gate.windowMs)) {
    return NextResponse.json(
      { error: "Too many boards. Try again later." },
      { status: 429, headers: JSON_HEADERS },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Give your board a title." },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  try {
    const policy = getPolicy();
    const board = await createBoard(body, boardApiDeps(policy));
    const hostCookie = issueHostCookie(board.slug, isSecureRequest(request), {
      sessionSecret: getConfig().sessionSecret,
      policy,
    });
    return NextResponse.json(
      { board: publicBoard(board) },
      {
        status: 201,
        headers: hostCookie ? { ...JSON_HEADERS, "Set-Cookie": hostCookie } : JSON_HEADERS,
      },
    );
  } catch (error) {
    return plusErrorResponse(error, "Could not create a board. Please try again.");
  }
}
