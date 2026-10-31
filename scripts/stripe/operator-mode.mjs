/**
 * PIN-210 Stripe operator mode: the one sandbox/live gate shared by
 * the operator scripts (seed-stripe-catalog, ensure-stripe-webhook-
 * endpoint, billing-reconciliation) and the vitest suite. Pure: no
 * env reads, no network, and no message ever echoes a key.
 *
 * Sandbox stays the default. A live run needs a live key AND both
 * flags; every mismatch (live key without --live, test key with
 * --live, half the flags, an unrecognised key) fails closed. Live
 * runs touch only the prod project and the prod webhook URL;
 * sandbox runs never touch them. docs/15, "Going live on prod".
 */

export const DEV_PROJECT_ID = "moriacrew-pinned-dev";
export const PROD_PROJECT_ID = "moriacrew-pinned-prod";
export const DEV_WEBHOOK_URL = "https://dev.pinneds.com/api/billing/stripe/webhook";
export const LIVE_WEBHOOK_URL = "https://pinneds.com/api/billing/stripe/webhook";
export const LIVE_FLAG = "--live";
export const LIVE_CONFIRM_FLAG = "--i-understand-live";

/** "live" | "test" | "unknown", from the key prefix only (sk_ secret or rk_ restricted). */
export function stripeKeyKind(key) {
  if (/^[sr]k_live_/.test(key)) return "live";
  if (/^[sr]k_test_/.test(key)) return "test";
  return "unknown";
}

const refuse = (error) => ({ ok: false, error });

/**
 * { ok: true, mode: "sandbox" | "live" } or { ok: false, error }.
 * `envName` names the env var in messages; the key itself never
 * appears in any output.
 */
export function resolveStripeMode({ key, envName, live, confirmed }) {
  const kind = stripeKeyKind(key);
  const both = `${LIVE_FLAG} ${LIVE_CONFIRM_FLAG}`;
  if (kind === "unknown") {
    return refuse(
      `Env var ${envName} does not hold a Stripe secret or restricted key (sk_/rk_ + test_/live_); refusing to run.`,
    );
  }
  if (confirmed && !live) {
    return refuse(`${LIVE_CONFIRM_FLAG} only counts together with ${LIVE_FLAG}; nothing was run.`);
  }
  if (kind === "live" && !live) {
    return refuse(
      `Env var ${envName} holds a LIVE key; sandbox is the default. Pass ${both} to target live mode on purpose.`,
    );
  }
  if (kind === "test" && live) {
    return refuse(
      `${LIVE_FLAG} was passed but env var ${envName} holds a test key; refusing a mixed run.`,
    );
  }
  if (live && !confirmed) {
    return refuse(`Live mode needs ${LIVE_CONFIRM_FLAG} as well as ${LIVE_FLAG}; nothing was run.`);
  }
  return { ok: true, mode: kind === "live" ? "live" : "sandbox" };
}

/** Error text when a mode may not touch `project`, else null. Live is prod-only; sandbox never prod. */
export function projectModeError(mode, project) {
  if (mode === "live" && project !== PROD_PROJECT_ID) {
    return `Live mode only targets project ${PROD_PROJECT_ID} (got ${project ?? "none; name it explicitly"}); refusing.`;
  }
  if (mode === "sandbox" && project === PROD_PROJECT_ID) {
    return `Sandbox mode never targets ${PROD_PROJECT_ID} (prod runs live Stripe); refusing.`;
  }
  return null;
}

/**
 * Webhook endpoint + Secret Manager target for a mode. Defaults:
 * sandbox = dev URL + dev project (unchanged since PIN-153), live =
 * prod URL + prod project, never the dev project. Overrides are
 * honoured but cannot cross modes.
 */
export function webhookTarget(mode, { url, project } = {}) {
  const live = mode === "live";
  const target = {
    url: url ?? (live ? LIVE_WEBHOOK_URL : DEV_WEBHOOK_URL),
    project: project ?? (live ? PROD_PROJECT_ID : DEV_PROJECT_ID),
  };
  const projectError = projectModeError(mode, target.project);
  if (projectError) return refuse(projectError);
  const crossUrl = live ? DEV_WEBHOOK_URL : LIVE_WEBHOOK_URL;
  if (target.url === crossUrl) {
    return refuse(`${mode} mode never registers ${crossUrl}; refusing.`);
  }
  return { ok: true, ...target };
}
