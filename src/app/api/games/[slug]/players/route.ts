import { NextResponse } from "next/server";
import { getConfig } from "../../../../../config";
import {
  PlayerJoinError,
  buildPlayerCookieHeader,
  joinGame,
  playerCookieName,
  publicPlayer,
  readCookieValue,
  resolvePlayerSession,
} from "../../../../../server/player-session";
import { getGameRepository } from "../../../../../server/repository";
import { RATE_LIMITS, checkRateLimit, clientKey } from "../../../../../server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JSON_HEADERS = { "Cache-Control": "no-store" };

function deps() {
  return {
    repository: getGameRepository(),
    sessionSecret: getConfig().sessionSecret,
  };
}

function isSecureRequest(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return proto === "https" || new URL(request.url).protocol === "https:";
}

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const cookie = readCookieValue(request.headers.get("cookie"), playerCookieName(slug));
  const player = await resolvePlayerSession(slug, cookie, deps());
  if (!player) {
    return NextResponse.json({ player: null }, { headers: JSON_HEADERS });
  }
  return NextResponse.json({ player: publicPlayer(player) }, { headers: JSON_HEADERS });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Send your display name and host preferences." },
      { status: 400, headers: JSON_HEADERS },
    );
  }

  try {
    const { slug } = await context.params;
    const gate = RATE_LIMITS.playersPerIpGame;
    if (!checkRateLimit(`${clientKey(request, "players")}:${slug}`, gate.limit, gate.windowMs)) {
      return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429, headers: JSON_HEADERS });
    }
    const existingCookie = readCookieValue(
      request.headers.get("cookie"),
      playerCookieName(slug),
    );
    const result = await joinGame(slug, body, existingCookie, deps());
    return NextResponse.json(
      { player: publicPlayer(result.player), outcome: result.outcome },
      {
        status: result.outcome === "created" ? 201 : 200,
        headers: {
          ...JSON_HEADERS,
          "Set-Cookie": buildPlayerCookieHeader(
            slug,
            result.cookieValue,
            result.cookieExpiresAt,
            isSecureRequest(request),
          ),
        },
      },
    );
  } catch (error) {
    if (error instanceof PlayerJoinError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: JSON_HEADERS },
      );
    }
    console.error("player join failed", error);
    return NextResponse.json(
      { error: "Could not join this game. Please try again." },
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
