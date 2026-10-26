/** Server configuration. Single place that reads process.env. */

export type AuthMode = "link-only" | "optional";

export interface AppConfig {
  authMode: AuthMode;
  aiMock: boolean;
  appBaseUrl: string;
}

/** FR8: unknown/missing values fail closed to link-only + mock AI. */
export function parseConfig(
  env: Readonly<Record<string, string | undefined>>,
): AppConfig {
  return {
    authMode: env.AUTH_MODE === "optional" ? "optional" : "link-only",
    aiMock: env.AI_MOCK !== "0",
    appBaseUrl: env.APP_BASE_URL ?? "http://localhost:3000",
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}
