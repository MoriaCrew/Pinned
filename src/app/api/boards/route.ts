import { NextResponse } from "next/server";
import { getPolicy } from "../../../policy/server";
import { createBoard, publicBoard } from "../../../server/board-api";
import { RATE_LIMITS, checkRateLimit, clientKey } from "../../../server/rate-limit";
import { JSON_HEADERS, boardApiDeps, errorResponse } from "./shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a board: { title, themeId? } -> 201 { board } with its slug link. */
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
    const board = await createBoard(body, boardApiDeps(getPolicy()));
    return NextResponse.json(
      { board: publicBoard(board) },
      { status: 201, headers: JSON_HEADERS },
    );
  } catch (error) {
    return errorResponse(error, "Could not create a board. Please try again.");
  }
}
