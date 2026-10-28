import { NextResponse } from "next/server";
import { verifyToken } from "../../../../../domain/tokens";
import { getGameRepository } from "../../../../../server/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JSON_HEADERS = { "Cache-Control": "no-store" };

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  let token = "";
  try {
    const body = (await request.json()) as { adminToken?: unknown };
    if (typeof body.adminToken === "string") token = body.adminToken;
  } catch {
    return NextResponse.json({ error: "Invalid admin link." }, { status: 401, headers: JSON_HEADERS });
  }

  const { slug } = await context.params;
  const game = await getGameRepository().getGame(slug);
  if (!game || !token || !verifyToken(token, game.adminTokenHash)) {
    return NextResponse.json({ error: "Invalid admin link." }, { status: 401, headers: JSON_HEADERS });
  }

  return NextResponse.json(
    {
      game: {
        id: game.id,
        state: game.state,
        challenge: game.challenge,
        persona: game.persona,
        deadlineAt: game.deadlineAt,
        entryCount: game.entryCount,
        createdAt: game.createdAt,
      },
    },
    { headers: JSON_HEADERS },
  );
}
