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

export type DataBackend = "firestore" | "memory";

export interface AppConfig {
  authMode: AuthMode;
  aiMock: boolean;
  appBaseUrl: string;
  dataBackend: DataBackend;
  firebaseProjectId: string | null;
  firestoreEmulatorHost: string | null;
  aiDailyBudgetUsd: number;
  aiDailyCallLimit: number;
  /** Raw POLICY_OVERRIDES_JSON; parsed/validated by src/policy (PIN-59). */
  policyOverridesJson: string | null;
  sessionSecret: string | null;
  /**
   * Seeded judge demo board slug (PIN-73). A capability secret:
   * set only via env (DEMO_BOARD_SLUG), never committed. Null =
   * the landing demo link stays hidden/inert.
   */
  demoBoardSlug: string | null;
  storageBucket: string | null;
  labEnabled: boolean;
  meta: MetaConfig;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Budget: explicit 0 means OFF (PIN-59); junk/negative fall back. */
function budgetNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Unknown DATA_BACKEND fails closed in production (PIN-59). */
function parseDataBackend(
  env: Readonly<Record<string, string | undefined>>,
): DataBackend {
  const raw = env.DATA_BACKEND;
  if (raw === undefined || raw === "" || raw === "memory") return "memory";
  if (raw === "firestore") return "firestore";
  if (env.NODE_ENV === "production") {
    throw new Error("Unknown DATA_BACKEND in production: " + raw);
  }
  return "memory";
}

/** Mirrors SLUG_PATTERN (domain/tokens): 22-char base64url slug. */
const DEMO_SLUG_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Invalid DEMO_BOARD_SLUG fails closed to "no demo link". */
function parseDemoBoardSlug(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && DEMO_SLUG_PATTERN.test(trimmed) ? trimmed : null;
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
    dataBackend: parseDataBackend(env),
    firebaseProjectId:
      nonEmpty(env.FIREBASE_PROJECT_ID) ??
      nonEmpty(env.GOOGLE_CLOUD_PROJECT) ??
      nonEmpty(env.GCLOUD_PROJECT),
    firestoreEmulatorHost: nonEmpty(env.FIRESTORE_EMULATOR_HOST),
    aiDailyBudgetUsd: budgetNumber(env.AI_DAILY_BUDGET_USD, 2),
    policyOverridesJson: nonEmpty(env.POLICY_OVERRIDES_JSON),
    aiDailyCallLimit: Math.floor(positiveNumber(env.AI_DAILY_CALL_LIMIT, 200)),
    labEnabled: env.PINNED_LAB === "1",
    sessionSecret: nonEmpty(env.SESSION_SECRET),
    demoBoardSlug: parseDemoBoardSlug(env.DEMO_BOARD_SLUG),
    storageBucket:
      nonEmpty(env.STORAGE_BUCKET) ??
      nonEmpty(env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET) ??
      (nonEmpty(env.FIREBASE_PROJECT_ID)
        ? `${nonEmpty(env.FIREBASE_PROJECT_ID)}.firebasestorage.app`
        : null),
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
