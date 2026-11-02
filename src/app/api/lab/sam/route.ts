import { NextResponse } from "next/server";
import { getConfig } from "../../../../config";
import { getModelGateway } from "../../../../gateway";
import {
  createMetaLogSink,
  reserveSamLabBudget,
} from "../../../../server/ai-usage";
import { getBudgetStore } from "../../../../server/budget-store";
import { MAX_PHOTO_BYTES, PhotoIntakeError } from "../../../../server/photo-intake";
import { getPolicy } from "../../../../policy/server";
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
    // getModelGateway already selects the mock under AI_MOCK=1
    // (explicit config, reported via `mock`); over budget the lab
    // pauses with a 429 instead of swapping silently (PIN-61).
    const gateway = getModelGateway({
      onLog: cfg.aiMock ? undefined : createMetaLogSink(repository, Date.now, getPolicy().aiCallLogRetentionDays),
    });
    const mock = cfg.aiMock;
    if (!cfg.aiMock) {
      // PIN-241: reserve atomically against the same BudgetStore
      // counter Studio traffic uses (fail closed on deny or store
      // error), replacing the racy scan-based pre-check. The lab's
      // raw ModelGateway shape cannot use the decorated ports, so
      // reserveSamLabBudget is the smallest correct seam.
      const reserved = await reserveSamLabBudget(
        getBudgetStore(),
        getPolicy(),
        { autoLabel: input.mode === "concept" && !!input.autoLabel },
      );
      if (!reserved) {
        return NextResponse.json(
          { error: "Daily AI guard reached on this environment. Lab is paused." },
          { status: 429, headers: JSON_HEADERS },
        );
      }
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
      { error: "Lab run failed." },
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
