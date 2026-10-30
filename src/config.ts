/** Server configuration. Single place that reads process.env. */
import { isFirebaseProjectId } from "./domain/auth-proxy";
import type { PlusMode } from "./domain/plus";

export type AuthMode = "link-only" | "optional";

/** Model IDs pinned by PIN-3 research (Standard mode; never
 *  *-contributor variants for player photos — docs/02 §8). */
export const DEFAULT_META_MODELS = {
  spark: "muse-spark-1.3",
  sam: "sam-3.1",
  image: "muse-image-1.0",
  voice: "muse-voice-transcribe-1.0",
} as const;

export interface MetaConfig {
  apiKey: string | null;
  baseUrl: string;
  sparkModel: string;
  samModel: string;
  imageModel: string;
  voiceModel: string;
}

export type DataBackend = "firestore" | "memory";

export interface AppConfig {
  authMode: AuthMode;
  /**
   * PIN-163 (docs/13-auth.md): AUTH_SAME_ORIGIN=1 in optional mode
   * serves Firebase's sign-in helper from the app's own host:
   * next.config.ts proxies `/__/auth/*` to the project's
   * firebaseapp host (src/domain/auth-proxy.ts). False for any
   * other value and always in link-only mode: nothing is proxied.
   */
  authSameOrigin: boolean;
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
   * Firebase web (client) config passthrough (PIN-83). These
   * NEXT_PUBLIC_* values are public identifiers, not secrets, and
   * are build-time inlined for the browser. Null when unset/empty:
   * the sign-in UI (PIN-84) then stays hidden, honestly, even if
   * AUTH_MODE=optional. Never invent values here.
   */
  firebaseWebApiKey: string | null;
  /**
   * NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, except with authSameOrigin,
   * an https APP_BASE_URL and a valid project id: then the
   * APP_BASE_URL host, served by the /__/auth proxy (PIN-163).
   */
  firebaseWebAuthDomain: string | null;
  /**
   * Seeded judge demo board slug (PIN-73). A capability secret:
   * set only via env (DEMO_BOARD_SLUG), never committed. Null =
   * the landing demo link stays hidden/inert.
   */
  demoBoardSlug: string | null;
  /**
   * Board Plus billing adapter (PIN-103, docs/15). "off" (the
   * default; anything but an exact known value) answers every
   * checkout "unavailable" and writes nothing; "mock" grants the
   * entitlement instantly with source "mock" for the demo. Never
   * set mock on prod. "stripe" (PIN-149) sells credit packs via
   * hosted Checkout and requires STRIPE_SECRET_KEY (below).
   */
  plusMode: PlusMode;
  /**
   * Stripe secret key (PIN-149): env-name only (STRIPE_SECRET_KEY,
   * a Secret Manager reference when hosted), never a value in git.
   * Null unless set; PLUS_MODE=stripe without it fails closed to
   * "off" below, so a misconfigured backend sells nothing instead
   * of erroring per request. Never log or expose this value.
   */
  stripeSecretKey: string | null;
  /**
   * Stripe webhook signing secret (PIN-150): env-name only
   * (STRIPE_WEBHOOK_SECRET), never a value in git. Null unless
   * set; the webhook route fails closed (503, nothing granted)
   * without it. The hosted value does not exist until the
   * endpoint is registered (PIN-153), so no apphosting yaml
   * references it yet. Never log or expose this value.
   */
  stripeWebhookSecret: string | null;
  /** Pinned Stripe API version (STRIPE_API_VERSION); bump deliberately with the SDK. */
  stripeApiVersion: typeof STRIPE_API_VERSION;
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

/**
 * The one place the Stripe API version is pinned (PIN-149).
 * Matches the bundled stripe SDK's ApiVersion; a config test
 * fails if an SDK bump moves it without this following.
 */
export const STRIPE_API_VERSION = "2026-10-28.endive" as const;

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * PIN-163: the client authDomain moves to the app's own host only
 * when the /__/auth proxy exists for it (same-origin opt-in and a
 * valid project id) and APP_BASE_URL is https. Anything else keeps
 * the configured value, silently.
 */
function resolveAuthDomain(input: {
  sameOrigin: boolean;
  appBaseUrl: string;
  projectId: string | null;
  configured: string | null;
}): string | null {
  if (!input.sameOrigin || !isFirebaseProjectId(input.projectId)) return input.configured;
  try {
    const url = new URL(input.appBaseUrl);
    return url.protocol === "https:" && url.hostname ? url.host : input.configured;
  } catch {
    return input.configured;
  }
}

/** FR8: unknown/missing values fail closed to link-only + mock AI. */
export function parseConfig(
  env: Readonly<Record<string, string | undefined>>,
): AppConfig {
  const authMode: AuthMode = env.AUTH_MODE === "optional" ? "optional" : "link-only";
  const authSameOrigin = env.AUTH_SAME_ORIGIN === "1" && authMode === "optional";
  const appBaseUrl = env.APP_BASE_URL ?? "http://localhost:3000";
  const firebaseProjectId =
    nonEmpty(env.FIREBASE_PROJECT_ID) ??
    nonEmpty(env.GOOGLE_CLOUD_PROJECT) ??
    nonEmpty(env.GCLOUD_PROJECT);
  return {
    authMode,
    authSameOrigin,
    aiMock: env.AI_MOCK !== "0",
    appBaseUrl,
    dataBackend: parseDataBackend(env),
    firebaseProjectId,
    firestoreEmulatorHost: nonEmpty(env.FIRESTORE_EMULATOR_HOST),
    aiDailyBudgetUsd: budgetNumber(env.AI_DAILY_BUDGET_USD, 2),
    policyOverridesJson: nonEmpty(env.POLICY_OVERRIDES_JSON),
    aiDailyCallLimit: Math.floor(positiveNumber(env.AI_DAILY_CALL_LIMIT, 200)),
    labEnabled: env.PINNED_LAB === "1",
    sessionSecret: nonEmpty(env.SESSION_SECRET),
    firebaseWebApiKey: nonEmpty(env.NEXT_PUBLIC_FIREBASE_API_KEY),
    firebaseWebAuthDomain: resolveAuthDomain({
      sameOrigin: authSameOrigin,
      appBaseUrl,
      projectId: firebaseProjectId,
      configured: nonEmpty(env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN),
    }),
    demoBoardSlug: parseDemoBoardSlug(env.DEMO_BOARD_SLUG),
    plusMode:
      env.PLUS_MODE === "mock"
        ? "mock"
        : env.PLUS_MODE === "stripe" && nonEmpty(env.STRIPE_SECRET_KEY)
          ? "stripe"
          : "off",
    stripeSecretKey: nonEmpty(env.STRIPE_SECRET_KEY),
    stripeWebhookSecret: nonEmpty(env.STRIPE_WEBHOOK_SECRET),
    stripeApiVersion: STRIPE_API_VERSION,
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
      voiceModel: nonEmpty(env.META_MODEL_VOICE) ?? DEFAULT_META_MODELS.voice,
    },
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}
