import { NextResponse } from "next/server";
import { t } from "../../../../../i18n";
import { getAiPorts } from "../../../../../server/ai-ports";
import { transcribeDictation } from "../../../../../server/dictation";
import {
  RATE_LIMITS,
  checkRateLimit,
  clientKey,
} from "../../../../../server/rate-limit";
import {
  JSON_HEADERS,
  errorResponse,
  policyForBoard,
  slugGate,
  viewerFor,
} from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dictate the Make-sheet idea (PIN-119): one multipart WAV clip
 * (the client encodes mono 16-bit PCM at 16kHz), transcribed via
 * the decorated SpeechTranscriber port. Slug gate first, then
 * the participant cookie; the clip is capped by Policy before it
 * is read into memory and is never persisted.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;

  const gate = RATE_LIMITS.submissionsPerIpGame;
  if (
    !checkRateLimit(`${clientKey(request, "transcribe")}:${slug}`, gate.limit, gate.windowMs)
  ) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a few minutes." },
      { status: 429, headers: JSON_HEADERS },
    );
  }

  try {
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    if (!viewer) {
      return NextResponse.json(
        { error: "Join this board before making a scene." },
        { status: 401, headers: JSON_HEADERS },
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json(
        { error: t("en", "dictate.badAudio") },
        { status: 400, headers: JSON_HEADERS },
      );
    }
    const file = form.get("audio");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: t("en", "dictate.badAudio") },
        { status: 400, headers: JSON_HEADERS },
      );
    }
    if (file.size > policy.dictationMaxBytes) {
      return NextResponse.json(
        { error: t("en", "dictate.tooLong") },
        { status: 413, headers: JSON_HEADERS },
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ports = getAiPorts({ policy });
    const result = await transcribeDictation(
      slug,
      viewer,
      { bytes, contentType: file.type },
      { transcriber: ports.speechTranscriber, policy },
    );
    return NextResponse.json(result, { headers: JSON_HEADERS });
  } catch (error) {
    return errorResponse(error, t("en", "make.dictateFailed"));
  }
}
