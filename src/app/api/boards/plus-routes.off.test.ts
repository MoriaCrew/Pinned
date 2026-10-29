import { beforeAll, describe, expect, it } from "vitest";

/**
 * Board Plus routes, PLUS_MODE=off (PIN-103, the default): a host
 * asking for Plus gets "unavailable" and nothing is written. Env
 * is set before the route modules first read config (dynamic
 * imports), like auth-routes.optional.test.ts.
 */
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-32";
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
let getBoard: (slug: string) => Promise<unknown>;

beforeAll(async () => {
  ({ POST: createBoardRoute } = await import("./route"));
  ({ GET: getBoardRoute } = await import("./[slug]/route"));
  ({ POST: plusRoute } = await import("./[slug]/plus/route"));
  const { getBoardRepository } = await import("../../../server/board-repository");
  getBoard = (slug) => getBoardRepository().getBoard(slug);
});

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe("POST /api/boards/[slug]/plus, PLUS_MODE=off (PIN-103)", () => {
  it("answers unavailable to the host and writes nothing", async () => {
    const created = await createBoardRoute(
      new Request("http://t/api/boards", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.103.1.1" },
        body: JSON.stringify({ title: "Off board" }),
      }),
    );
    expect(created.status).toBe(201);
    const { board } = (await created.json()) as { board: { slug: string } };
    const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toMatch(/^pinned_host_/);
    const before = await getBoard(board.slug);

    for (const plan of ["board", "host"]) {
      const res = await plusRoute(
        new Request(`http://t/api/boards/${board.slug}/plus`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ plan }),
        }),
        params(board.slug),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "unavailable" });
    }
    expect(await getBoard(board.slug)).toEqual(before);

    const viewRes = await getBoardRoute(
      new Request(`http://t/api/boards/${board.slug}`, { headers: { cookie } }),
      params(board.slug),
    );
    const view = (await viewRes.json()) as { viewer: unknown; plus: unknown };
    expect(view.viewer).toEqual({ isHost: true });
    expect(view.plus).toEqual({
      active: false,
      mode: "off",
      priceLabels: { board: "$3.99", host: "$4.99/month" },
    });
  });
});
