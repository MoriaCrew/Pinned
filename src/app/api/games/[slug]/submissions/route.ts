import { NextResponse } from "next/server";
import { getConfig } from "../../../../../config";
import { getDerivativeStore } from "../../../../../server/derivative-store";
import { MAX_PHOTO_BYTES, PhotoIntakeError } from "../../../../../server/photo-intake";
import {
  playerCookieName,
  readCookieValue,
} from "../../../../../server/player-session";
import { getGameRepository } from "../../../../../server/repository";
import { RATE_LIMITS, checkRateLimit, clientKey } from "../../../../../server/rate-limit";
import {
  SubmitPhotoError,
  getOwnSubmission,
  publicOwnSubmission,
  submitPhoto,
} from "../../../../../server/submit-photo";
import { getModelGateway } from "../../../../../gateway";
import { mockGateway } from "../../../../../gateway/mock-gateway";
import { createMetaLogSink, getTodayAiUsage, isAiBudgetExhausted } from "../../../../../server/ai-usage";
import { judgeSubmission } from "../../../../../server/judge-submission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JSON_HEADERS = { "Cache-Control": "no-store" };

function sessionDeps() {
  return {
    repository: getGameRepository(),
    sessionSecret: getConfig().sessionSecret,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const cookie = readCookieValue(request.headers.get("cookie"), playerCookieName(slug));
  const own = await getOwnSubmission(slug, cookie, sessionDeps());
  if (!own) {
    return NextResponse.json(
      { error: "Join this game before submitting a photo." },
      { status: 401, headers: JSON_HEADERS },
    );
  }
  return NextResponse.json(
    { submission: own.submission ? publicOwnSubmission(own.submission) : null },
    { headers: JSON_HEADERS },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gate = RATE_LIMITS.submissionsPerIpGame;
  if (!checkRateLimit(`${clientKey(request, "submit")}:${slug}`, gate.limit, gate.windowMs)) {
    return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429, headers: JSON_HEADERS });
  }
  const lengthHeader = request.headers.get("content-length");
  const contentLength = Number(lengthHeader ?? NaN);
  if (!lengthHeader || !Number.isFinite(contentLength) || contentLength <= 0) {
    return NextResponse.json(
      { error: "Send the photo with a content length." },
      { status: 411, headers: JSON_HEADERS },
    );
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_PHOTO_BYTES + 1024 * 1024) {
    return NextResponse.json(
      { error: "That photo is too large. Keep it under 10 MB." },
      { status: 413, headers: JSON_HEADERS },
    );
  }

  let photo: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("photo");
    if (value instanceof File) photo = value;
  } catch {
    return NextResponse.json(
      { error: "Send the photo as a form upload." },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  if (photo && photo.size > MAX_PHOTO_BYTES) {
    return NextResponse.json(
      { error: "That photo is too large. Keep it under 10 MB." },
      { status: 413, headers: JSON_HEADERS },
    );
  }
  if (!photo || photo.size === 0) {
    return NextResponse.json(
      { error: "Choose a photo to upload." },
      { status: 400, headers: JSON_HEADERS },
    );
  }

  try {
    const cookie = readCookieValue(request.headers.get("cookie"), playerCookieName(slug));
    const bytes = new Uint8Array(await photo.arrayBuffer());
    const result = await submitPhoto(slug, cookie, bytes, {
      ...sessionDeps(),
      store: getDerivativeStore(),
    });
    // Judge inline, best-effort (PIN-44): the entry stands even
    // when judging fails; it stays retryable within the attempt cap.
    let judgedSubmission = result.submission;
    try {
      const config = getConfig();
      const repository = getGameRepository();
      let gateway = getModelGateway({ onLog: config.aiMock ? undefined : createMetaLogSink(repository) });
      if (!config.aiMock && isAiBudgetExhausted(await getTodayAiUsage(repository), config)) gateway = mockGateway;
      const judged = await judgeSubmission(slug, result.submission.id, { repository, gateway, store: getDerivativeStore() });
      judgedSubmission = judged.submission;
    } catch (judgeError) {
      console.warn("judging failed; entry kept", { slug, error: String(judgeError) });
    }
    return NextResponse.json(
      {
        submission: publicOwnSubmission(judgedSubmission),
        outcome: result.outcome,
        width: result.width,
        height: result.height,
      },
      { status: result.outcome === "created" ? 201 : 200, headers: JSON_HEADERS },
    );
  } catch (error) {
    if (error instanceof PhotoIntakeError || error instanceof SubmitPhotoError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: JSON_HEADERS },
      );
    }
    console.error("photo submission failed", error);
    return NextResponse.json(
      { error: "That photo could not be submitted. Please try again." },
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
