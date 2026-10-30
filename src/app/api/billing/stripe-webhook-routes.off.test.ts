import { beforeAll, describe, expect, it } from "vitest";

/**
 * Stripe webhook route with PLUS_MODE=off (PIN-150): fails
 * closed with 503 before any signature work, so a hosted
 * backend that never flipped to stripe (and has no webhook
 * secret yet - PIN-153 creates it) can never grant.
 */
process.env.PLUS_MODE = "off";
process.env.AI_MOCK = "1";
process.env.DATA_BACKEND = "memory";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

let webhookRoute: (request: Request) => Promise<Response>;

beforeAll(async () => {
  ({ POST: webhookRoute } = await import("./stripe/webhook/route"));
});

describe("POST /api/billing/stripe/webhook (off mode, PIN-150)", () => {
  it("503s fail-closed, with or without a signature header", async () => {
    const withSig = await webhookRoute(
      new Request("http://t/api/billing/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=fake" },
        body: "{}",
      }),
    );
    expect(withSig.status).toBe(503);
    expect(await withSig.json()).toEqual({ error: "webhook_unavailable" });
    const noSig = await webhookRoute(
      new Request("http://t/api/billing/stripe/webhook", { method: "POST", body: "{}" }),
    );
    expect(noSig.status).toBe(503);
  });
});
