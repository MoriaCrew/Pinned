import { NextResponse } from "next/server";
import { getModelGateway } from "../../../gateway";
import { mockGateway } from "../../../gateway/mock-gateway";
import {
  CreateGameValidationError,
  createGame,
  parseCreateGameInput,
} from "../../../server/create-game";
import { getConfig } from "../../../config";
import { getPublicOrigin } from "../../../server/public-origin";
import { getGameRepository } from "../../../server/repository";
import { createMetaLogSink, getTodayAiUsage, isAiBudgetExhausted } from "../../../server/ai-usage";
import { RATE_LIMITS, checkRateLimit, clientKey } from "../../../server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JSON_HEADERS = { "Cache-Control": "no-store" };

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: JSON_HEADERS });
}

export async function POST(request: Request): Promise<NextResponse> {
  const gate = RATE_LIMITS.createGamePerIp;
  if (!checkRateLimit(clientKey(request, "create"), gate.limit, gate.windowMs)) {
    return errorResponse("Too many games from this connection. Try again in a few minutes.", 429);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Send a JSON object with a host brief and deadline.", 400);
  }

  try {
    const input = parseCreateGameInput(body);
    const repository = getGameRepository();
    const config = getConfig();
    let gateway = getModelGateway({
      onLog: config.aiMock ? undefined : createMetaLogSink(repository),
    });
    if (!config.aiMock) {
      const usage = await getTodayAiUsage(repository);
      if (isAiBudgetExhausted(usage, config)) {
        console.warn("AI daily guard reached; using mock persona fallback", usage);
        gateway = mockGateway;
      }
    }
    const { game, adminToken } = await createGame(input, {
      repository,
      gateway,
    });

    const origin = getPublicOrigin(request, config.appBaseUrl);
    const playerUrl = `${origin}/g/${game.id}`;
    const adminUrl = `${origin}/g/${game.id}/admin#token=${encodeURIComponent(adminToken)}`;
    const deadline = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      // Date only, no clock time: the invite is read in other timezones
      // and the game page shows each viewer their local deadline.
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
          `Pinneds: ${game.persona.name} is hosting a photo game. ` +
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
