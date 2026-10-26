/** Server configuration. Single place that reads process.env. */

export type AuthMode = "link-only" | "optional";

/** Model IDs pinned by PIN-3 research (Standard mode; never
 *  *-contributor variants for player photos — docs/02 §8). */
export const DEFAULT_META_MODELS = {
  spark: "muse-spark-1.3",
  sam: "sam-3.1",
  image: "muse-image-1.0",
} as const;

export interface MetaConfig {
  apiKey: string | null;
  baseUrl: string;
  sparkModel: string;
  samModel: string;
  imageModel: string;
}

export interface AppConfig {
  authMode: AuthMode;
  aiMock: boolean;
  appBaseUrl: string;
  meta: MetaConfig;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** FR8: unknown/missing values fail closed to link-only + mock AI. */
export function parseConfig(
  env: Readonly<Record<string, string | undefined>>,
): AppConfig {
  return {
    authMode: env.AUTH_MODE === "optional" ? "optional" : "link-only",
    aiMock: env.AI_MOCK !== "0",
    appBaseUrl: env.APP_BASE_URL ?? "http://localhost:3000",
    meta: {
      apiKey: nonEmpty(env.META_API_KEY),
      baseUrl: (nonEmpty(env.META_API_BASE_URL) ?? "https://api.meta.ai/v1").replace(/\/$/, ""),
      sparkModel: nonEmpty(env.META_MODEL_SPARK) ?? DEFAULT_META_MODELS.spark,
      samModel: nonEmpty(env.META_MODEL_SAM) ?? DEFAULT_META_MODELS.sam,
      imageModel: nonEmpty(env.META_MODEL_IMAGE) ?? DEFAULT_META_MODELS.image,
    },
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}
