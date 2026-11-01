/**
 * Webhook endpoint convergence plan (PIN-153): the pure decision
 * behind `scripts/ensure-stripe-webhook-endpoint.mjs`, mirroring
 * the catalog seed pattern (PIN-146) - the script carries the
 * same constants/logic and a test pins the mirror. Payload
 * style: endpoints created through the classic
 * `POST /v1/webhook_endpoints` API deliver snapshot events (the
 * full resource in `data.object`; in the newer event-destination
 * API the same choice is `event_payload=snapshot`), which is
 * what the PIN-150 handler parses. The endpoint's `api_version`
 * is pinned in lockstep with the SDK in `src/config.ts`.
 */
import { STRIPE_WEBHOOK_EVENT_TYPES } from "../server/stripe-webhook";

/** The hosted dev webhook target (PIN-150 route on the dev backend). */
export const DEV_WEBHOOK_URL = "https://dev.pinneds.com/api/billing/stripe/webhook";

/**
 * The prod (pinneds.com) target for the live account (PIN-210).
 * The script's live/sandbox gate lives in
 * `scripts/stripe/operator-mode.mjs`; a test pins both URLs there.
 */
export const LIVE_WEBHOOK_URL = "https://pinneds.com/api/billing/stripe/webhook";

/** The exact event list to register: PIN-150's list, nothing else. */
export const WEBHOOK_ENDPOINT_EVENTS: readonly string[] = STRIPE_WEBHOOK_EVENT_TYPES;

/** The shape of a listed v1 webhook endpoint the planner reads. */
export interface ExistingWebhookEndpoint {
  id: string;
  url: string;
  status: string;
  enabledEvents: readonly string[];
}

export type WebhookEndpointPlan =
  | { kind: "create" }
  | {
      kind: "reuse";
      endpointId: string;
      disabled: boolean;
      /** Desired events the endpoint does not carry. */
      missingEvents: string[];
      /** Events the endpoint carries beyond the desired list. */
      extraEvents: string[];
    };

/**
 * Match by URL (endpoint identity for this integration): no
 * endpoint at the URL -> create; one there -> reuse and report
 * any event drift or disabled state. A wildcard `*` counts as
 * drift, never as a match: the endpoint must carry exactly the
 * documented events.
 */
export function planWebhookEndpoint(
  existing: readonly ExistingWebhookEndpoint[],
  desiredUrl: string,
  desiredEvents: readonly string[],
): WebhookEndpointPlan {
  const found = existing.find((endpoint) => endpoint.url === desiredUrl);
  if (!found) return { kind: "create" };
  const carried = new Set(found.enabledEvents);
  const wanted = new Set(desiredEvents);
  return {
    kind: "reuse",
    endpointId: found.id,
    disabled: found.status !== "enabled",
    missingEvents: desiredEvents.filter((event) => !carried.has(event)),
    extraEvents: found.enabledEvents.filter((event) => !wanted.has(event)),
  };
}

/** True when a reuse plan needs no operator action. */
export function webhookEndpointConverged(plan: WebhookEndpointPlan): boolean {
  return (
    plan.kind === "reuse" &&
    !plan.disabled &&
    plan.missingEvents.length === 0 &&
    plan.extraEvents.length === 0
  );
}
