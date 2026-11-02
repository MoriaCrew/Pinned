import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * PIN-241 route guards through the real handlers, memory backends,
 * AI_MOCK=1: scenes/chips/tap-add POSTs cap their JSON bodies via
 * readJsonCapped (413 past the Policy cap, before any board read),
 * and tap-add carries the per-IP+board rate-limit brake the other
 * paid POSTs already had. getLocale() is stubbed (it reads
 * next/headers). Env is set BEFORE the route modules first read
 * config.
 */
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-32";
process.env.AI_MOCK = "1";
process.env.DATA_BACKEND = "memory";

vi.mock("../../../i18n/server", () => ({ getLocale: async (): Promise<string> => "en" }));

type Handler = (request: Request) => Promise<Response>;
type SlugHandler = (
  request: Request,
  context: { params: Promise<{ slug: string }> },
) => Promise<Response>;
type TapHandler = (
  request: Request,
  context: { params: Promise<{ slug: string; jobId: string }> },
) => Promise<Response>;

let createBoardRoute: Handler;
let scenesRoute: SlugHandler;
let chipsRoute: SlugHandler;
let tapAddRoute: TapHandler;

beforeAll(async () => {
  ({ POST: createBoardRoute } = await import("./route"));
  ({ POST: scenesRoute } = await import("./[slug]/scenes/route"));
  ({ POST: chipsRoute } = await import("./[slug]/chips/route"));
  ({ POST: tapAddRoute } = await import("./[slug]/jobs/[jobId]/tap-add/route"));
});

let ipSeq = 0;
const ip = () => `10.241.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const slugParams = (slug: string) => ({ params: Promise.resolve({ slug }) });
const tapParams = (slug: string) => ({
  params: Promise.resolve({ slug, jobId: "job-1" }),
});

async function newBoard(): Promise<string> {
  const res = await createBoardRoute(
    new Request("http://t/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ title: "Caps board" }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { board: { slug: string } }).board.slug;
}

function post(body: string, fromIp: string): Request {
  return new Request("http://t/x", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": fromIp },
    body,
  });
}

describe("capped JSON bodies (PIN-241)", () => {
  it("scenes POST answers 413 past sceneRequestMaxBytes, 401 (not 413) at a normal size", async () => {
    const slug = await newBoard();
    const huge = JSON.stringify({ elementIds: ["el-1"], prompt: "x".repeat(5000) });
    const over = await scenesRoute(post(huge, ip()), slugParams(slug));
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ code: "body_too_large" });
    // A normal body passes the cap and reaches the join gate.
    const normal = await scenesRoute(
      post(JSON.stringify({ elementIds: ["el-1"], prompt: "hi" }), ip()),
      slugParams(slug),
    );
    expect(normal.status).toBe(401);
  });

  it("chips POST answers 413 past chipsRequestMaxBytes", async () => {
    const slug = await newBoard();
    const huge = JSON.stringify({ elementIds: ["el-1"], pad: "x".repeat(3000) });
    const over = await chipsRoute(post(huge, ip()), slugParams(slug));
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ code: "body_too_large" });
    const normal = await chipsRoute(
      post(JSON.stringify({ elementIds: ["el-1"] }), ip()),
      slugParams(slug),
    );
    expect(normal.status).toBe(401);
  });

  it("tap-add POST answers 413 past tapAddMaxBytes; a normal point reaches the uniform 404", async () => {
    const slug = await newBoard();
    const huge = JSON.stringify({ x: 0.5, y: 0.5, pad: "x".repeat(2000) });
    const over = await tapAddRoute(post(huge, ip()), tapParams(slug));
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ code: "body_too_large" });
    const normal = await tapAddRoute(
      post(JSON.stringify({ x: 0.5, y: 0.5 }), ip()),
      tapParams(slug),
    );
    expect(normal.status).toBe(404); // no participant cookie: uniform miss
  });

  it("unparseable JSON keeps the routes' old 400s", async () => {
    const slug = await newBoard();
    expect((await scenesRoute(post("{nope", ip()), slugParams(slug))).status).toBe(400);
    expect((await chipsRoute(post("{nope", ip()), slugParams(slug))).status).toBe(400);
    expect((await tapAddRoute(post("{nope", ip()), tapParams(slug))).status).toBe(400);
  });
});

describe("tap-add rate limit (PIN-241)", () => {
  it("the 31st POST from one IP on one board in the window is a 429", async () => {
    const slug = await newBoard();
    const fromIp = ip();
    for (let i = 0; i < 30; i += 1) {
      const res = await tapAddRoute(
        post(JSON.stringify({ x: 0.5, y: 0.5 }), fromIp),
        tapParams(slug),
      );
      expect(res.status).toBe(404); // passes the brake, misses as no session
    }
    const limited = await tapAddRoute(
      post(JSON.stringify({ x: 0.5, y: 0.5 }), fromIp),
      tapParams(slug),
    );
    expect(limited.status).toBe(429);
    // A different IP keeps its own bucket.
    const other = await tapAddRoute(
      post(JSON.stringify({ x: 0.5, y: 0.5 }), ip()),
      tapParams(slug),
    );
    expect(other.status).toBe(404);
  });
});
