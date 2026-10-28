/**
 * SAM lab service (PIN-36). Dev-only exploration tool: run one
 * segmentation over an uploaded photo and get back everything a
 * human needs to judge it — overlay, cut-outs, masks, stats, and
 * the exact prompt used. Reuses the real intake + gateway so lab
 * findings transfer directly to PIN-8. With AI_MOCK=1 it returns a
 * clearly-labelled synthetic ellipse mask so the UI works offline.
 */
import { buildObjectPrompt, ObjectPromptError } from "@meta-sam/parser";
import sharp from "sharp";
import type { ModelGateway } from "../gateway/model-gateway";
import { processPhoto } from "./photo-intake";
import {
  decodeSegment,
  renderCutout,
  renderMask,
  renderOverlay,
  type DecodedSegment,
} from "./sam-mask";

export type LabMode = "concept" | "points" | "box";

export interface LabPoint {
  x: number; // 0..1 fraction of width
  y: number; // 0..1 fraction of height
  label: "positive" | "negative";
}

export interface LabBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} // fractions 0..1

export interface SamLabInput {
  mode: LabMode;
  concept?: string;
  autoLabel?: boolean;
  points?: LabPoint[];
  box?: LabBox;
  maskEncoding?: "lossless" | "one_bit";
  includeConfidence?: boolean;
}

export class SamLabError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 502 = 400,
  ) {
    super(message);
    this.name = "SamLabError";
  }
}

export interface SamLabSegmentView {
  id: string;
  box: { x1: number; y1: number; x2: number; y2: number };
  confidence: number | null;
  maskPixels: number;
  coverageFramePct: number;
  coverageBoxPct: number;
  cutoutPng: string; // data URL
  maskPng: string; // data URL
}

export interface SamLabResult {
  mock: boolean;
  image: { width: number; height: number; dataUrl: string };
  promptUsed: string;
  judge: { objectLabel: string; altLabel: string } | null;
  timingsMs: { intake: number; segment: number; total: number };
  segments: SamLabSegmentView[];
  overlayJpeg: string; // data URL
}

const MODES: readonly LabMode[] = ["concept", "points", "box"];
const MAX_SEGMENTS_RENDERED = 12;

function fraction(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new SamLabError("Points and boxes must be fractions between 0 and 1.");
  }
  return n;
}

export function parseSamLabInput(fields: {
  mode?: string | null;
  concept?: string | null;
  autoLabel?: string | null;
  points?: string | null;
  box?: string | null;
  maskEncoding?: string | null;
  includeConfidence?: string | null;
}): SamLabInput {
  const mode = (fields.mode ?? "concept") as LabMode;
  if (!MODES.includes(mode)) throw new SamLabError("Unknown lab mode.");
  const input: SamLabInput = {
    mode,
    concept: (fields.concept ?? "").trim().slice(0, 120),
    autoLabel: fields.autoLabel === "1",
    maskEncoding: fields.maskEncoding === "one_bit" ? "one_bit" : "lossless",
    includeConfidence: fields.includeConfidence === "1",
  };
  if (fields.points) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fields.points);
    } catch {
      throw new SamLabError("Points must be JSON.");
    }
    if (!Array.isArray(parsed) || parsed.length > 20) {
      throw new SamLabError("Send at most 20 points.");
    }
    input.points = parsed.map((p) => {
      const point = p as { x?: unknown; y?: unknown; label?: unknown };
      return {
        x: fraction(point.x),
        y: fraction(point.y),
        label: point.label === "negative" ? ("negative" as const) : ("positive" as const),
      };
    });
  }
  if (fields.box) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fields.box);
    } catch {
      throw new SamLabError("Box must be JSON.");
    }
    const b = parsed as { x1?: unknown; y1?: unknown; x2?: unknown; y2?: unknown };
    input.box = {
      x1: fraction(b.x1),
      y1: fraction(b.y1),
      x2: fraction(b.x2),
      y2: fraction(b.y2),
    };
  }
  if (mode === "points" && !input.points?.some((p) => p.label === "positive")) {
    throw new SamLabError("Tap the object at least once.");
  }
  if (mode === "box" && !input.box) throw new SamLabError("Draw a box first.");
  if (mode === "concept" && !input.concept && !input.autoLabel) {
    throw new SamLabError("Name the object, or turn on auto-name.");
  }
  return input;
}

function mockDecodedSegment(width: number, height: number): DecodedSegment {
  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.max(8, Math.round(width * 0.28));
  const ry = Math.max(8, Math.round(height * 0.28));
  const x1 = Math.round(cx - rx);
  const y1 = Math.round(cy - ry);
  const x2 = Math.round(cx + rx);
  const y2 = Math.round(cy + ry);
  const maskWidth = x2 - x1 + 1;
  const maskHeight = y2 - y1 + 1;
  const raster = new Uint8Array(maskWidth * maskHeight);
  let maskPixels = 0;
  for (let y = 0; y < maskHeight; y++) {
    for (let x = 0; x < maskWidth; x++) {
      const nx = (x - rx) / rx;
      const ny = (y - ry) / ry;
      if (nx * nx + ny * ny <= 1) {
        raster[y * maskWidth + x] = 1;
        maskPixels++;
      }
    }
  }
  return {
    id: "mock",
    box: { x1, y1, x2, y2 },
    raster,
    maskWidth,
    maskHeight,
    maskPixels,
    coverageFrame: maskPixels / (width * height),
    coverageBox: maskPixels / (maskWidth * maskHeight),
  };
}

const pct = (v: number) => Math.round(v * 1000) / 10;

export async function runSamLab(
  bytes: Uint8Array,
  input: SamLabInput,
  deps: { gateway: ModelGateway; mock: boolean },
): Promise<SamLabResult> {
  const started = Date.now();
  const processed = await processPhoto(bytes);
  const intakeMs = Date.now() - started;
  const { width, height } = processed;
  const imageDataUrl = `data:image/webp;base64,${processed.derivative.toString("base64")}`;

  let promptUsed = input.concept ?? "";
  let judge: SamLabResult["judge"] = null;
  let decoded: DecodedSegment[] = [];

  const segmentStarted = Date.now();
  if (deps.mock) {
    decoded = [mockDecodedSegment(width, height)];
    promptUsed = promptUsed || "(mock ellipse — AI_MOCK=1, SAM not called)";
  } else {
    let promptText: string | undefined;
    if (input.mode === "points" || input.mode === "box") {
      try {
        promptText = buildObjectPrompt({
          size: { width, height },
          objects: [
            {
              id: 1,
              prompts: [
                {
                  // Mode-scoped: leftover geometry from another tab
                  // must never leak into this run's prompt.
                  ...(input.mode === "box" && input.box
                    ? {
                        box: {
                          left: Math.round(input.box.x1 * width),
                          top: Math.round(input.box.y1 * height),
                          right: Math.round(input.box.x2 * width),
                          bottom: Math.round(input.box.y2 * height),
                        },
                      }
                    : {}),
                  ...(input.mode === "points" && input.points?.length
                    ? {
                        points: input.points.map((p) => ({
                          x: Math.round(p.x * width),
                          y: Math.round(p.y * height),
                          label: p.label,
                        })),
                      }
                    : {}),
                },
              ],
            },
          ],
        });
      } catch (cause) {
        if (cause instanceof ObjectPromptError) throw new SamLabError(cause.message);
        throw cause;
      }
      promptUsed = promptText;
    } else if (input.autoLabel) {
      const judged = await deps.gateway.judgePhoto({
        imageRef: imageDataUrl,
        challenge: "Name the main object in this photo.", persona: { name: "Test Host", voiceRules: ["Dry."], catchphrases: [], judgingStyle: "Rubric-first." },
      });
      judge = { objectLabel: judged.objectLabel, altLabel: judged.altLabel };
      promptUsed = judged.objectLabel || promptUsed;
      if (!promptUsed) throw new SamLabError("Auto-name found no object label.", 502);
    }

    let raw;
    try {
      raw = await deps.gateway.segmentObject({
        imageRef: imageDataUrl,
        concept: promptUsed,
        promptText,
        maskEncoding: input.maskEncoding,
        includeConfidence: input.includeConfidence,
      });
    } catch (cause) {
      throw new SamLabError(
        `SAM call failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        502,
      );
    }
    decoded = raw.segments
      .slice(0, MAX_SEGMENTS_RENDERED)
      .map((segment) => decodeSegment(segment, { width, height }));
  }
  const segmentMs = Date.now() - segmentStarted;

  const overlayPng = await renderOverlay(processed.derivative, decoded);
  const overlayJpeg = `data:image/jpeg;base64,${(await sharp(overlayPng).jpeg({ quality: 82 }).toBuffer()).toString("base64")}`;

  const segments: SamLabSegmentView[] = [];
  for (const segment of decoded) {
    const [cutout, mask] = await Promise.all([
      renderCutout(processed.derivative, segment),
      renderMask(segment),
    ]);
    segments.push({
      id: segment.id,
      box: segment.box,
      confidence: segment.confidence ?? null,
      maskPixels: segment.maskPixels,
      coverageFramePct: pct(segment.coverageFrame),
      coverageBoxPct: pct(segment.coverageBox),
      cutoutPng: `data:image/png;base64,${cutout.toString("base64")}`,
      maskPng: `data:image/png;base64,${mask.toString("base64")}`,
    });
  }

  return {
    mock: deps.mock,
    image: { width, height, dataUrl: imageDataUrl },
    promptUsed,
    judge,
    timingsMs: { intake: intakeMs, segment: segmentMs, total: Date.now() - started },
    segments,
    overlayJpeg,
  };
}
