export type StripeOperatorMode = "sandbox" | "live";
export type StripeKeyKind = "live" | "test" | "unknown";
export type Refusal = { ok: false; error: string };

export const DEV_PROJECT_ID: "moriacrew-pinned-dev";
export const PROD_PROJECT_ID: "moriacrew-pinned-prod";
export const DEV_WEBHOOK_URL: string;
export const LIVE_WEBHOOK_URL: string;
export const LIVE_FLAG: "--live";
export const LIVE_CONFIRM_FLAG: "--i-understand-live";

export function stripeKeyKind(key: string): StripeKeyKind;
export function resolveStripeMode(args: {
  key: string;
  envName: string;
  live: boolean;
  confirmed: boolean;
}): { ok: true; mode: StripeOperatorMode } | Refusal;
export function projectModeError(mode: StripeOperatorMode, project: string | undefined): string | null;
export function webhookTarget(
  mode: StripeOperatorMode,
  overrides?: { url?: string; project?: string },
): { ok: true; url: string; project: string } | Refusal;
