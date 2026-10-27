import { NextResponse } from "next/server";
import { getModelGateway } from "../../../gateway";
import {
  CreateGameValidationError,
  createGame,
  parseCreateGameInput,
} from "../../../server/create-game";
import { getConfig } from "../../../config";
import { getPublicOrigin } from "../../../server/public-origin";
import { getGameRepository } from "../../../server/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JSON_HEADERS = { "Cache-Control": "no-store" };

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: JSON_HEADERS });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Send a JSON object with a host brief and deadline.", 400);
  }

  try {
    const input = parseCreateGameInput(body);
    const { game, adminToken } = await createGame(input, {
      repository: getGameRepository(),
      gateway: getModelGateway(),
    });

    const origin = getPublicOrigin(request, getConfig().appBaseUrl);
    const playerUrl = `${origin}/g/${game.id}`;
    const adminUrl = `${origin}/g/${game.id}/admin#token=${encodeURIComponent(adminToken)}`;
    const deadline = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(game.deadlineAt);

    return NextResponse.json(
      {
        game: {
          id: game.id,
          chainId: game.chainId,
          state: game.state,
          brief: game.brief,
          challenge: game.challenge,
          persona: game.persona,
          deadlineAt: game.deadlineAt,
          entryCount: game.entryCount,
          createdAt: game.createdAt,
        },
        playerUrl,
        adminUrl,
        adminToken,
        inviteText:
          `Pinned: ${game.persona.name} is hosting a photo game. ` +
          `Challenge: ${game.challenge} Join before ${deadline} UTC: ${playerUrl}`,
      },
      { status: 201, headers: JSON_HEADERS },
    );
  } catch (error) {
    if (error instanceof CreateGameValidationError) {
      return errorResponse(error.message, 400);
    }
    console.error("create game failed", error);
    return errorResponse("The game could not be created. Please try again.", 500);
  }
}
