import { beforeAll, describe, expect, it } from "vitest";
import { generateSlug } from "../../../domain/tokens";

/**
 * Credit-pack buy + billing-return routes (PIN-149) with
 * PLUS_MODE=off on the memory backends: the Stripe happy path is
 * covered at the adapter/service level with a fake client, so
 * here the real handlers prove the wire behaviour that needs no
 * provider - gates, participant/host auth, typed errors, the
 * rate limit, off -> unavailable with nothing written, and the
 * opaque return redirector. Env is set before the route modules
 * first read config (dynamic imports, like plus-routes).
 */
process.env.PLUS_MODE = "off";
process.env.AI_MOCK = "1";
process.env.DATA_BACKEND = "memory";
process.env.SESSION_SECRET = "s".repeat(40);
process.env.POLICY_OVERRIDES_JSON = JSON.stringify({
  credits: { checkoutPerIp: { limit: 3, windowMs: 600_000 } },
});

type SlugHandler = (
  request: Request,
  context: { params: Promise<{ slug: string }> },
) => Promise<Response>;

let createBoardRoute: (request: Request) => Promise<Response>;
let joinRoute: SlugHandler;
let buyRoute: SlugHandler;
let returnRoute: (request: Request) => Promise<Response>;
let getIntents: typeof import("../../../server/checkout-intent-store")["getCheckoutIntentStore"];
let getLedger: typeof import("../../../server/credit-ledger-store")["getCreditLedgerStore"];

beforeAll(async () => {
  ({ POST: createBoardRoute } = await import("./route"));
  ({ POST: joinRoute } = await import("./[slug]/participants/route"));
  ({ POST: buyRoute } = await import("./[slug]/credits/checkout/route"));
  ({ GET: returnRoute } = await import("../../billing/return/route"));
  ({ getCheckoutIntentStore: getIntents } = await import(
    "../../../server/checkout-intent-store"
  ));
  ({ getCreditLedgerStore: getLedger } = await import(
    "../../../server/credit-ledger-store"
  ));
});

let ipSeq = 0;
const freshIp = () => `10.149.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

async function hostedBoard() {
  const res = await createBoardRoute(
    new Request("http://t/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ title: "Credits route board" }),
    }),
  );
  expect(res.status).toBe(201);
  const { board } = (await res.json()) as { board: { slug: string } };
  const hostCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return { slug: board.slug, hostCookie };
}

async function joinedCookie(slug: string): Promise<string> {
  const res = await joinRoute(
    new Request(`http://t/api/boards/${slug}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ displayName: "Buyer" }),
    }),
    params(slug),
  );
  expect(res.status).toBe(201);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

interface Send {
  cookie?: string;
  ip?: string;
  headers?: Record<string, string>;
  raw?: string;
}

function buy(slug: string, body: unknown, opts: Send = {}) {
  return buyRoute(
    new Request(`http://t/api/boards/${slug}/credits/checkout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": opts.ip ?? freshIp(),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...opts.headers,
      },
      body: opts.raw ?? JSON.stringify(body),
    }),
    params(slug),
  );
}

describe("POST /api/boards/[slug]/credits/checkout, PLUS_MODE=off (PIN-149)", () => {
  it("invalid slug -> uniform 404", async () => {
    const res = await buy("a/b", { lookupKey: "pinneds_plus_20" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found." });
  });

  it("request guards: cross-site 403, non-JSON 415", async () => {
    const { slug, hostCookie } = await hostedBoard();
    const cross = await buy(
      slug,
      { lookupKey: "pinneds_plus_20" },
      { cookie: hostCookie, headers: { "sec-fetch-site": "cross-site" } },
    );
    expect(cross.status).toBe(403);
    expect(await cross.json()).toMatchObject({ code: "cross_site" });
    const form = await buy(slug, null, {
      cookie: hostCookie,
      headers: { "content-type": "text/plain" },
      raw: "lookupKey=pinneds_plus_20",
    });
    expect(form.status).toBe(415);
    expect(await form.json()).toMatchObject({ code: "unsupported_media_type" });
  });

  it("no board session -> 401 participant_required, even for unknown boards", async () => {
    const { slug } = await hostedBoard();
    for (const target of [slug, generateSlug()]) {
      const res = await buy(target, { lookupKey: "pinneds_plus_20" });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "participant_required" });
    }
  });

  it("joined participant: unknown pack 400, known pack unavailable, nothing written", async () => {
    const { slug } = await hostedBoard();
    const cookie = await joinedCookie(slug);
    const bad = await buy(slug, { lookupKey: "pinneds_credits_999" }, { cookie });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "pack_unknown" });
    const ok = await buy(slug, { lookupKey: "pinneds_plus_20" }, { cookie });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "unavailable" });
    expect(await getLedger().getAccount(slug)).toBeNull();
  });

  it("the host cookie alone also authorizes a buy attempt", async () => {
    const { slug, hostCookie } = await hostedBoard();
    const res = await buy(slug, { lookupKey: "pinneds_plus_20" }, { cookie: hostCookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unavailable" });
    expect(await getLedger().getAccount(slug)).toBeNull();
  });

  it("per-IP budget from Policy.credits.checkoutPerIp -> 429", async () => {
    const { slug, hostCookie } = await hostedBoard();
    const ip = freshIp();
    for (let i = 0; i < 3; i++) {
      expect(
        (await buy(slug, { lookupKey: "pinneds_plus_20" }, { cookie: hostCookie, ip }))
          .status,
      ).toBe(200);
    }
    const limited = await buy(
      slug,
      { lookupKey: "pinneds_plus_20" },
      { cookie: hostCookie, ip },
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
  });
});

describe("GET /billing/return (PIN-149)", () => {
  it("known intent -> board with a flag; unknown/expired -> one generic landing", async () => {
    const { slug } = await hostedBoard();
    const now = Date.now();
    const intent = await getIntents().create({
      boardId: slug,
      packLookupKey: "pinneds_plus_20",
      credits: 20,
      at: now,
      intentTtlSeconds: 1_800,
      pendingIntentCapPerBoard: 3,
    });
    const back = await returnRoute(
      new Request(`http://localhost:3000/billing/return?intent=${intent.id}&result=success`),
    );
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`http://localhost:3000/g/${slug}?billing=processing`);
    const cancelled = await returnRoute(
      new Request(`http://localhost:3000/billing/return?intent=${intent.id}&result=cancel`),
    );
    expect(cancelled.headers.get("location")).toBe(
      `http://localhost:3000/g/${slug}?billing=cancelled`,
    );

    const stale = await getIntents().create({
      boardId: slug,
      packLookupKey: "pinneds_plus_20",
      credits: 20,
      at: now - 7_200_000,
      intentTtlSeconds: 1_800,
      pendingIntentCapPerBoard: 3,
    });
    for (const target of [
      "http://localhost:3000/billing/return",
      "http://localhost:3000/billing/return?intent=12345678-1234-4234-8234-1234567890ab&result=success",
      `http://localhost:3000/billing/return?intent=${stale.id}&result=success`,
    ]) {
      const res = await returnRoute(new Request(target));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost:3000/");
    }
    // Regression (Bugbot on PIN-149): behind App Hosting the raw
    // request origin is the internal 0.0.0.0:8080; the redirect
    // must use the public origin like the buy route does.
    const hosted = await returnRoute(
      new Request(`http://0.0.0.0:8080/billing/return?intent=${intent.id}&result=success`, {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "boards.example",
          host: "0.0.0.0:8080",
        },
      }),
    );
    expect(hosted.status).toBe(302);
    expect(hosted.headers.get("location")).toBe(
      `https://boards.example/g/${slug}?billing=processing`,
    );
    // Returning never grants: no account was conjured by any redirect.
    expect(await getLedger().getAccount(slug)).toBeNull();
  });
});
