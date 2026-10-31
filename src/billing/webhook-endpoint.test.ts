import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STRIPE_API_VERSION } from "../config";
import { STRIPE_WEBHOOK_EVENT_TYPES } from "../server/stripe-webhook";
import * as operatorMode from "../../scripts/stripe/operator-mode.mjs";
import {
  DEV_WEBHOOK_URL,
  LIVE_WEBHOOK_URL,
  WEBHOOK_ENDPOINT_EVENTS,
  planWebhookEndpoint,
  webhookEndpointConverged,
  type ExistingWebhookEndpoint,
} from "./webhook-endpoint";

/** PIN-153: pure planning behind scripts/ensure-stripe-webhook-endpoint.mjs; fakes only. */
function endpoint(
  overrides: Partial<ExistingWebhookEndpoint> = {},
): ExistingWebhookEndpoint {
  return {
    id: "we_fake_1",
    url: DEV_WEBHOOK_URL,
    status: "enabled",
    enabledEvents: [...STRIPE_WEBHOOK_EVENT_TYPES],
    ...overrides,
  };
}

describe("webhook endpoint plan (PIN-153)", () => {
  it("registers exactly the PIN-150 event list at the dev URL", () => {
    expect(WEBHOOK_ENDPOINT_EVENTS).toEqual([...STRIPE_WEBHOOK_EVENT_TYPES]);
    expect(WEBHOOK_ENDPOINT_EVENTS).toHaveLength(11);
    expect(DEV_WEBHOOK_URL).toBe("https://dev.pinneds.com/api/billing/stripe/webhook");
  });

  it("creates when no endpoint sits at the URL", () => {
    expect(planWebhookEndpoint([], DEV_WEBHOOK_URL, WEBHOOK_ENDPOINT_EVENTS)).toEqual({
      kind: "create",
    });
    expect(
      planWebhookEndpoint(
        [endpoint({ url: "https://example.test/other" })],
        DEV_WEBHOOK_URL,
        WEBHOOK_ENDPOINT_EVENTS,
      ),
    ).toEqual({ kind: "create" });
  });

  it("reuses a converged endpoint", () => {
    const plan = planWebhookEndpoint(
      [endpoint()],
      DEV_WEBHOOK_URL,
      WEBHOOK_ENDPOINT_EVENTS,
    );
    expect(plan).toEqual({
      kind: "reuse",
      endpointId: "we_fake_1",
      disabled: false,
      missingEvents: [],
      extraEvents: [],
    });
    expect(webhookEndpointConverged(plan)).toBe(true);
  });

  it("reports missing events, extra events and disabled state as drift", () => {
    const plan = planWebhookEndpoint(
      [
        endpoint({
          status: "disabled",
          enabledEvents: ["checkout.session.completed", "charge.refunded"],
        }),
      ],
      DEV_WEBHOOK_URL,
      WEBHOOK_ENDPOINT_EVENTS,
    );
    expect(plan.kind).toBe("reuse");
    if (plan.kind !== "reuse") return;
    expect(plan.disabled).toBe(true);
    expect(plan.extraEvents).toEqual(["charge.refunded"]);
    expect(plan.missingEvents).toContain("refund.created");
    expect(plan.missingEvents).not.toContain("checkout.session.completed");
    expect(webhookEndpointConverged(plan)).toBe(false);
  });

  it("a wildcard endpoint is drift, not convergence", () => {
    const plan = planWebhookEndpoint(
      [endpoint({ enabledEvents: ["*"] })],
      DEV_WEBHOOK_URL,
      WEBHOOK_ENDPOINT_EVENTS,
    );
    expect(webhookEndpointConverged(plan)).toBe(false);
    if (plan.kind !== "reuse") return;
    expect(plan.extraEvents).toEqual(["*"]);
    expect(plan.missingEvents).toHaveLength(11);
  });

  it("the ensure script carries the same URLs, events and API version (mirror)", () => {
    const script = readFileSync(
      path.resolve(__dirname, "../../scripts/ensure-stripe-webhook-endpoint.mjs"),
      "utf8",
    );
    // PIN-210: both URLs live in the shared operator-mode module the script imports.
    expect(script).toContain('from "./stripe/operator-mode.mjs"');
    expect(operatorMode.DEV_WEBHOOK_URL).toBe(DEV_WEBHOOK_URL);
    expect(operatorMode.LIVE_WEBHOOK_URL).toBe(LIVE_WEBHOOK_URL);
    expect(LIVE_WEBHOOK_URL).toBe("https://pinneds.com/api/billing/stripe/webhook");
    expect(script).toContain(STRIPE_API_VERSION);
    for (const event of STRIPE_WEBHOOK_EVENT_TYPES) {
      expect(script).toContain(`"${event}"`);
    }
  });
});
