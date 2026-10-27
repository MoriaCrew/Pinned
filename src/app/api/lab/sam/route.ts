import { NextResponse } from "next/server";
import { getConfig } from "../../../../config";
import { getModelGateway } from "../../../../gateway";
import { mockGateway } from "../../../../gateway/mock-gateway";
import {
  createMetaLogSink,
  getTodayAiUsage,
  isAiBudgetExhausted,
} from "../../../../server/ai-usage";
import { MAX_PHOTO_BYTES, PhotoIntakeError } from "../../../../server/photo-intake";
import { getGameRepository } from "../../../../server/repository";
import { RATE_LIMITS, checkRateLimit, clientKey } from "../../../../server/rate-limit";
import { SamLabError, parseSamLabInput, runSamLab } from "../../../../server/sam-lab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JSON_HEADERS = { "Cache-Control": "no-store" };

/** Lab exists on dev (PINNED_LAB=1) and local memory mode only. */
function labAvailable(): boolean {
  const cfg = getConfig();
  return cfg.labEnabled || cfg.dataBackend === "memory";
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!labAvailable()) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: JSON_HEADERS });
  }
  const gate = RATE_LIMITS.labPerIp;
  if (!checkRateLimit(clientKey(request, "lab"), gate.limit, gate.windowMs)) {
    return NextResponse.json({ error: "Lab rate limit reached. Try again in a few minutes." }, { status: 429, headers: JSON_HEADERS });
  }
  const lengthHeader = request.headers.get("content-length");
  const contentLength = Number(lengthHeader ?? NaN);
  if (!lengthHeader || !Number.isFinite(contentLength) || contentLength <= 0) {
    return NextResponse.json({ error: "Send the photo with a content length." }, { status: 411, headers: JSON_HEADERS });
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_PHOTO_BYTES + 1024 * 1024) {
    return NextResponse.json(
      { error: "Photo too large (10 MB max)." },
      { status: 413, headers: JSON_HEADERS },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Send a multipart form with a photo." },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    return NextResponse.json(
      { error: "Choose a photo." },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : null;
  };

  try {
    const input = parseSamLabInput({
      mode: text("mode"),
      concept: text("concept"),
      autoLabel: text("autoLabel"),
      points: text("points"),
      box: text("box"),
      maskEncoding: text("maskEncoding"),
      includeConfidence: text("includeConfidence"),
    });
    const cfg = getConfig();
    const repository = getGameRepository();
    let gateway = getModelGateway({
      onLog: cfg.aiMock ? undefined : createMetaLogSink(repository),
    });
    let mock = cfg.aiMock;
    if (!cfg.aiMock) {
      const usage = await getTodayAiUsage(repository);
      if (isAiBudgetExhausted(usage, cfg)) {
        return NextResponse.json(
          { error: "Daily AI guard reached on this environment. Lab is paused." },
          { status: 429, headers: JSON_HEADERS },
        );
      }
    } else {
      gateway = mockGateway;
      mock = true;
    }
    const bytes = new Uint8Array(await photo.arrayBuffer());
    const result = await runSamLab(bytes, input, { gateway, mock });
    return NextResponse.json(result, { headers: JSON_HEADERS });
  } catch (error) {
    if (error instanceof PhotoIntakeError || error instanceof SamLabError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: JSON_HEADERS },
      );
    }
    console.error("sam lab failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Lab run failed." },
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
