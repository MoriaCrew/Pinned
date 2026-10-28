import { NextResponse } from "next/server";
import { getConfig } from "../../../../../../config";
import { getModelGateway } from "../../../../../../gateway";
import { mockGateway } from "../../../../../../gateway/mock-gateway";
import { createMetaLogSink, getTodayAiUsage, isAiBudgetExhausted } from "../../../../../../server/ai-usage";
import { CutoutConfirmError, confirmCutout, parseCutoutAction } from "../../../../../../server/confirm-cutout";
import { getDerivativeStore } from "../../../../../../server/derivative-store";
import { playerCookieName, readCookieValue } from "../../../../../../server/player-session";
import { RATE_LIMITS, checkRateLimit, clientKey } from "../../../../../../server/rate-limit";
import { getGameRepository } from "../../../../../../server/repository";
import { publicOwnSubmission } from "../../../../../../server/submit-photo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JSON_HEADERS = { "Cache-Control": "no-store" };

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gate = RATE_LIMITS.submissionsPerIpGame;
  if (!checkRateLimit(`${clientKey(request, "submit")}:${slug}`, gate.limit, gate.windowMs)) {
    return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429, headers: JSON_HEADERS });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send a cut-out action." }, { status: 400, headers: JSON_HEADERS });
  }
  try {
    const action = parseCutoutAction(body);
    const config = getConfig();
    const repository = getGameRepository();
    let gateway = getModelGateway({ onLog: config.aiMock ? undefined : createMetaLogSink(repository) });
    if (!config.aiMock && isAiBudgetExhausted(await getTodayAiUsage(repository), config)) gateway = mockGateway;
    const cookie = readCookieValue(request.headers.get("cookie"), playerCookieName(slug));
    const result = await confirmCutout(slug, cookie, action, {
      repository,
      sessionSecret: config.sessionSecret,
      gateway,
      store: getDerivativeStore(),
    });
    return NextResponse.json(
      { submission: publicOwnSubmission(result.submission), outcome: result.outcome },
      { headers: JSON_HEADERS },
    );
  } catch (error) {
    if (error instanceof CutoutConfirmError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: JSON_HEADERS });
    }
    console.error("cut-out confirm failed", error);
    return NextResponse.json({ error: "That cut-out change failed. Please try again." }, { status: 500, headers: JSON_HEADERS });
  }
}
