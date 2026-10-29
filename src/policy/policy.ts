/**
 * Policy — every Studio limit lives here (docs/11 §5.1, PIN-59).
 * Pure module (client-safe): no env reads, no server imports.
 * Resolution order: code defaults < env layer < per-board overrides.
 * Env access stays in src/config.ts; see src/policy/server.ts.
 */
import { z } from "zod";

const Range = z.object({
  min: z.number().int().min(0),
  max: z.number().int().min(0),
});

const FractionRange = z.object({
  min: z.number().min(0).max(1),
  max: z.number().min(0).max(1),
});

export const PolicySchema = z
  .object({
    elementsPerPhoto: Range.default({ min: 1, max: 6 }),
    conceptMaxWords: z.number().int().min(1).default(3),
    pinsPerScene: Range.default({ min: 1, max: 4 }),
    photosPerParticipantPerDay: z.number().int().min(0).default(20),
    scenesPerParticipantPerDay: z.number().int().min(0).default(10),
    scenesPerBoardPerDay: z.number().int().min(0).default(40),
    /** Scene prompt length cap (PIN-69). */
    /** Scene image Cache-Control max-age for chat crawlers (PIN-72). */
    sceneImageCacheMaxAgeSeconds: z.number().int().min(0).default(300),
    scenePromptMaxChars: z.number().int().min(1).default(500),
    workingCopyTtlHours: z.number().positive().default(24),
    /** Board API caps (PIN-65): join roster, title length, cookie life. */
    participantsPerBoard: z.number().int().min(1).default(50),
    boardTitleMaxChars: z.number().int().min(1).default(80),
    participantCookieDays: z.number().int().min(1).default(30),
    /** Board page poll cadence (docs/11 section 5.8, PIN-66). */
    boardPollIntervalMs: z.number().int().min(250).default(5_000),
    /** Add-sheet job poll cadence while SAM lands (PIN-67). */
    jobPollIntervalMs: z.number().int().min(250).default(1_500),
    /** Client downscale before upload (docs/11 section 5.8, PIN-67). */
    uploadMaxPx: z.number().int().positive().default(1600),
    uploadJpegQuality: z.number().min(0.1).max(1).default(0.85),
    faces: z.enum(["allow", "note", "block"]).default("note"),
    // PIN-50 locks: flattened won T2; portrait verified; store=false ok.
    sceneInputMode: z
      .enum(["flattened", "transparent", "whole"])
      .default("flattened"),
    sceneSize: z.string().min(3).default("1024x1536"),
    sceneStore: z.boolean().default(false),
    timeoutsMs: z
      .object({
        spark: z.number().int().positive().default(30_000),
        sam: z.number().int().positive().default(20_000),
        scene: z.number().int().positive().default(120_000),
      })
      .default({ spark: 30_000, sam: 20_000, scene: 120_000 }),
    retries: z.number().int().min(0).default(1),
    /** Backoff before the single 429/5xx retry (PIN-61). */
    retryBackoffMs: z.number().int().min(0).default(500),
    samConcurrency: z.number().int().min(1).default(4),
    /** Usable-mask window, share of frame (PIN-50 lock: 0.5%-60%). */
    usableMaskFrameFraction: FractionRange.default({ min: 0.005, max: 0.6 }),
    /** Flattened scene-input bounds (docs/11 section 5.6, PIN-50 spike). */
    flattenedMaxPx: z.number().int().positive().default(1024),
    flattenedPaddingFraction: z.number().min(0).max(1).default(0.08),
    maxTokens: z
      .object({
        // Spike: 1500 starved Spark reasoning; 4000 required.
        sparkElements: z.number().int().positive().default(4000),
      })
      .default({ sparkElements: 4000 }),
    /** 0 means OFF (PIN-59); never a silent fallback. */
    dailyBudgetUsd: z.number().min(0).default(2),
    dailyCallLimit: z.number().int().min(0).default(200),
    models: z
      .object({
        spark: z.string().min(1).default("muse-spark-1.3"),
        sam: z.string().min(1).default("sam-3.1"),
        image: z.string().min(1).default("muse-image-1.0"),
      })
      .default({
        spark: "muse-spark-1.3",
        sam: "sam-3.1",
        image: "muse-image-1.0",
      }),
    promptVersions: z
      .object({
        elements: z.string().min(1).default("elements.v1"),
        scene: z.string().min(1).default("scene.v1"),
      })
      .default({ elements: "elements.v1", scene: "scene.v1" }),
    /** Fixed suggestion chips for slice 2 (docs/11 Q10 default). */
    sceneChips: z
      .array(z.string().min(1))
      .default([
        "on a sunny picnic blanket",
        "in a tiny museum",
        "floating in space",
        "at a birthday party",
      ]),
  })
  .superRefine((p, ctx) => {
    if (p.elementsPerPhoto.max < p.elementsPerPhoto.min) {
      ctx.addIssue({
        code: "custom",
        path: ["elementsPerPhoto"],
        message: "elementsPerPhoto.max < min",
      });
    }
    if (p.usableMaskFrameFraction.max < p.usableMaskFrameFraction.min) {
      ctx.addIssue({
        code: "custom",
        path: ["usableMaskFrameFraction"],
        message: "usableMaskFrameFraction.max < min",
      });
    }
    if (p.pinsPerScene.max < p.pinsPerScene.min) {
      ctx.addIssue({
        code: "custom",
        path: ["pinsPerScene"],
        message: "pinsPerScene.max < min",
      });
    }
  });

export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = PolicySchema.parse({});

const RangeOverride = Range.partial();
const FractionRangeOverride = FractionRange.partial();
export const PolicyOverridesSchema = z.object({
  elementsPerPhoto: RangeOverride.optional(),
  conceptMaxWords: z.number().int().min(1).optional(),
  pinsPerScene: RangeOverride.optional(),
  photosPerParticipantPerDay: z.number().int().min(0).optional(),
  scenesPerParticipantPerDay: z.number().int().min(0).optional(),
  scenesPerBoardPerDay: z.number().int().min(0).optional(),
  scenePromptMaxChars: z.number().int().min(1).optional(),
  sceneImageCacheMaxAgeSeconds: z.number().int().min(0).optional(),
  workingCopyTtlHours: z.number().positive().optional(),
  participantsPerBoard: z.number().int().min(1).optional(),
  boardTitleMaxChars: z.number().int().min(1).optional(),
  participantCookieDays: z.number().int().min(1).optional(),
  boardPollIntervalMs: z.number().int().min(250).optional(),
  jobPollIntervalMs: z.number().int().min(250).optional(),
  uploadMaxPx: z.number().int().positive().optional(),
  uploadJpegQuality: z.number().min(0.1).max(1).optional(),
  faces: z.enum(["allow", "note", "block"]).optional(),
  sceneInputMode: z.enum(["flattened", "transparent", "whole"]).optional(),
  sceneSize: z.string().min(3).optional(),
  sceneStore: z.boolean().optional(),
  timeoutsMs: z
    .object({
      spark: z.number().int().positive().optional(),
      sam: z.number().int().positive().optional(),
      scene: z.number().int().positive().optional(),
    })
    .optional(),
  retries: z.number().int().min(0).optional(),
  retryBackoffMs: z.number().int().min(0).optional(),
  samConcurrency: z.number().int().min(1).optional(),
  usableMaskFrameFraction: FractionRangeOverride.optional(),
  flattenedMaxPx: z.number().int().positive().optional(),
  flattenedPaddingFraction: z.number().min(0).max(1).optional(),
  maxTokens: z
    .object({ sparkElements: z.number().int().positive().optional() })
    .optional(),
  dailyBudgetUsd: z.number().min(0).optional(),
  dailyCallLimit: z.number().int().min(0).optional(),
  models: z
    .object({
      spark: z.string().min(1).optional(),
      sam: z.string().min(1).optional(),
      image: z.string().min(1).optional(),
    })
    .optional(),
  promptVersions: z
    .object({
      elements: z.string().min(1).optional(),
      scene: z.string().min(1).optional(),
    })
    .optional(),
  sceneChips: z.array(z.string().min(1)).optional(),
});

export type PolicyOverrides = z.infer<typeof PolicyOverridesSchema>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge plain objects; arrays and scalars replace. */
function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] =
      isPlainObject(v) && isPlainObject(out[k])
        ? deepMerge(out[k] as Record<string, unknown>, v)
        : v;
  }
  return out;
}

/**
 * Resolve a Policy: defaults < envLayer < boardOverrides.
 * Throws (fail closed) on any invalid layer.
 */
export function resolvePolicy(
  envLayer?: PolicyOverrides | null,
  boardOverrides?: PolicyOverrides | null,
): Policy {
  let merged: Record<string, unknown> = {
    ...(DEFAULT_POLICY as unknown as Record<string, unknown>),
  };
  for (const layer of [envLayer, boardOverrides]) {
    if (!layer) continue;
    const parsed = PolicyOverridesSchema.parse(layer);
    merged = deepMerge(merged, parsed as Record<string, unknown>);
  }
  return PolicySchema.parse(merged);
}

/** Parse the POLICY_OVERRIDES_JSON env value. Throws on bad JSON/shape. */
export function parsePolicyOverridesJson(
  raw: string | null | undefined,
): PolicyOverrides | null {
  if (!raw || !raw.trim()) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("POLICY_OVERRIDES_JSON is not valid JSON");
  }
  return PolicyOverridesSchema.parse(json);
}
