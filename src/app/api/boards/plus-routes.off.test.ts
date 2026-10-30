import { beforeAll, describe, expect, it } from "vitest";
import { PLUS_SKIN_IDS } from "../../../domain/plus";

/**
 * Board Plus routes, PLUS_MODE=off (PIN-103, the default): a host
 * asking for Plus gets "unavailable" and nothing is written, and a
 * leftover mock grant unlocks nothing. Env is set before the route
 * modules first read config (dynamic imports), like
 * auth-routes.optional.test.ts.
 */
process.env.PLUS_MODE = "off";
process.env.AI_MOCK = "1";
process.env.DATA_BACKEND = "memory";

type SlugHandler = (
  request: Request,
  context: { params: Promise<{ slug: string }> },
) => Promise<Response>;

let createBoardRoute: (request: Request) => Promise<Response>;
let getBoardRoute: SlugHandler;
let plusRoute: SlugHandler;
let skinRoute: SlugHandler;
let repo: Awaited<typeof import("../../../server/board-repository")>["getBoardRepository"];

beforeAll(async () => {
  ({ POST: createBoardRoute } = await import("./route"));
  ({ GET: getBoardRoute } = await import("./[slug]/route"));
  ({ POST: plusRoute } = await import("./[slug]/plus/route"));
  ({ PATCH: skinRoute } = await import("./[slug]/skin/route"));
  ({ getBoardRepository: repo } = await import("../../../server/board-repository"));
});

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const json = (cookie: string, body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify(body),
});

async function hostedBoard(ip: string) {
  const created = await createBoardRoute(
    new Request("http://t/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ title: "Off board" }),
    }),
  );
  expect(created.status).toBe(201);
  const { board } = (await created.json()) as { board: { slug: string } };
  const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toMatch(/^pinned_host_[A-Za-z0-9_-]{22}=h1\./);
  return { slug: board.slug, cookie };
}

async function viewOf(slug: string, cookie: string) {
  const res = await getBoardRoute(new Request(`http://t/api/boards/${slug}`, { headers: { cookie } }), params(slug));
  return (await res.json()) as { viewer: unknown; plus: unknown };
}

describe("PLUS_MODE=off (PIN-103)", () => {
  it("POST plus answers unavailable to the host and writes nothing", async () => {
    const { slug, cookie } = await hostedBoard("10.103.200.1");
    const before = await repo().getBoard(slug);
    for (const plan of ["board", "host"]) {
      const res = await plusRoute(new Request(`http://t/api/boards/${slug}/plus`, json(cookie, { plan })), params(slug));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "unavailable" });
    }
    expect(await repo().getBoard(slug)).toEqual(before);
    const view = await viewOf(slug, cookie);
    expect(view.viewer).toEqual({ isHost: true });
    expect(view.plus).toEqual({
      active: false,
      mode: "off",
      priceLabels: { board: "$3.99", host: "$4.99/month" },
    });
  });

  it("a leftover mock grant counts for nothing: inactive view, Plus skin 402", async () => {
    const { slug, cookie } = await hostedBoard("10.103.200.2");
    await repo().updateBoardSettings(slug, () => ({
      plus: { plan: "host", source: "mock", grantedAt: 1 },
    }));
    expect((await viewOf(slug, cookie)).plus).toMatchObject({ active: false, mode: "off" });
    const res = await skinRoute(
      new Request(`http://t/api/boards/${slug}/skin`, json(cookie, { skinId: PLUS_SKIN_IDS[0] }, "PATCH")),
      params(slug),
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "plus_required" });
  });
});
