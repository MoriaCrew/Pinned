import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateSlug } from "../../../domain/tokens";

/**
 * Board Plus routes, PLUS_MODE=mock (PIN-103): real handlers on the
 * memory backends with AI_MOCK=1. Env is set BEFORE the route
 * modules first read config, so handlers are imported dynamically
 * (same pattern as auth-routes.optional.test.ts). The off-mode
 * twin lives in plus-routes.off.test.ts.
 */
const SECRET = "test-secret-test-secret-test-secret-32";
process.env.SESSION_SECRET = SECRET;
process.env.PLUS_MODE = "mock";
process.env.AI_MOCK = "1";
process.env.DATA_BACKEND = "memory";

// board-themes.ts gains the PIN-103 skin ids in a parallel change;
// extend the registry here so this suite pins route behaviour only.
vi.mock("../../../domain/board-themes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../domain/board-themes")>();
  const skins = ["paper", "cork", "fridge", "zine", "darkroom", "postcard", "marigold"];
  return {
    ...actual,
    isBoardThemeId: (value: unknown): value is string =>
      actual.isBoardThemeId(value) || (typeof value === "string" && skins.includes(value)),
  };
});

type SlugHandler = (
  request: Request,
  context: { params: Promise<{ slug: string }> },
) => Promise<Response>;

let createBoardRoute: (request: Request) => Promise<Response>;
let getBoardRoute: SlugHandler;
let skinRoute: SlugHandler;
let plusRoute: SlugHandler;
let getBoard: (slug: string) => Promise<{ themeId?: string; plus?: unknown; version: number } | null>;

beforeAll(async () => {
  ({ POST: createBoardRoute } = await import("./route"));
  ({ GET: getBoardRoute } = await import("./[slug]/route"));
  ({ PATCH: skinRoute } = await import("./[slug]/skin/route"));
  ({ POST: plusRoute } = await import("./[slug]/plus/route"));
  const { getBoardRepository } = await import("../../../server/board-repository");
  getBoard = (slug) => getBoardRepository().getBoard(slug);
});

let ipSeq = 0;
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

async function createHostedBoard(
  headers: Record<string, string> = {},
): Promise<{ slug: string; cookie: string; setCookie: string }> {
  const res = await createBoardRoute(
    new Request("http://t/api/boards", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Distinct client per board keeps the create rate limit out of the way.
        "x-forwarded-for": `10.103.0.${++ipSeq}`,
        ...headers,
      },
      body: JSON.stringify({ title: "Plus route board" }),
    }),
  );
  expect(res.status).toBe(201);
  const { board } = (await res.json()) as { board: { slug: string } };
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { slug: board.slug, cookie: setCookie.split(";")[0], setCookie };
}

function patchSkin(slug: string, body: unknown, cookie?: string): Promise<Response> {
  return skinRoute(
    new Request(`http://t/api/boards/${slug}/skin`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
    params(slug),
  );
}

function postPlus(slug: string, body: unknown, cookie?: string): Promise<Response> {
  return plusRoute(
    new Request(`http://t/api/boards/${slug}/plus`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
    params(slug),
  );
}

async function view(slug: string, cookie?: string) {
  const res = await getBoardRoute(
    new Request(`http://t/api/boards/${slug}`, { headers: cookie ? { cookie } : {} }),
    params(slug),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    board: { themeId: string | null };
    viewer: { isHost: boolean };
    plus: { active: boolean; plan?: string; mode: string; priceLabels: { board: string; host: string } };
  };
}

describe("host cookie on board creation (PIN-103)", () => {
  it("sets an httpOnly per-board host cookie with the Policy max age", async () => {
    const { slug, setCookie } = await createHostedBoard();
    expect(setCookie).toMatch(new RegExp(`^pinned_host_${slug}=[A-Za-z0-9_-]{43}; `));
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain(`Max-Age=${365 * 24 * 60 * 60}`);
    expect(setCookie).not.toContain("Secure");
    const https = await createHostedBoard({ "x-forwarded-proto": "https" });
    expect(https.setCookie).toContain("Secure");
  });

  it("board view: isHost only with this board's cookie; Plus offer in mock mode", async () => {
    const a = await createHostedBoard();
    const b = await createHostedBoard();
    const asHost = await view(a.slug, a.cookie);
    expect(asHost.viewer).toEqual({ isHost: true });
    expect(asHost.plus).toEqual({
      active: false,
      mode: "mock",
      priceLabels: { board: "$3.99", host: "$4.99/month" },
    });
    expect((await view(a.slug)).viewer).toEqual({ isHost: false });
    expect((await view(a.slug, b.cookie)).viewer).toEqual({ isHost: false });
  });
});

describe("PATCH /api/boards/[slug]/skin (PIN-103)", () => {
  it("invalid slug -> uniform 404", async () => {
    for (const slug of ["a/b", "short", "..%2f.."]) {
      const res = await patchSkin(slug, { skinId: "cork" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found." });
    }
  });

  it("no host cookie, or another board's -> 403 (unknown board too)", async () => {
    const a = await createHostedBoard();
    const b = await createHostedBoard();
    for (const res of [
      await patchSkin(a.slug, { skinId: "cork" }),
      await patchSkin(a.slug, { skinId: "cork" }, b.cookie),
      await patchSkin(generateSlug(), { skinId: "cork" }, a.cookie),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "host_only" });
    }
    expect((await getBoard(a.slug))?.version).toBe(1);
  });

  it("unknown skin -> 400", async () => {
    const { slug, cookie } = await createHostedBoard();
    const res = await patchSkin(slug, { skinId: "velvet" }, cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "skin_unknown" });
  });

  it("Plus skin without the entitlement -> 402 plus_required, nothing written", async () => {
    const { slug, cookie } = await createHostedBoard();
    const res = await patchSkin(slug, { skinId: "darkroom" }, cookie);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("plus_required");
    expect(body.error.length).toBeGreaterThan(0);
    expect(await getBoard(slug)).toMatchObject({ version: 1 });
    expect((await getBoard(slug))?.themeId).toBeUndefined();
  });

  it("free skin -> 200 and persisted", async () => {
    const { slug, cookie } = await createHostedBoard();
    const res = await patchSkin(slug, { skinId: "cork" }, cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { board: { themeId: string } }).board.themeId).toBe("cork");
    expect(await getBoard(slug)).toMatchObject({ themeId: "cork", version: 2 });
    expect((await view(slug)).board.themeId).toBe("cork");
  });

  it("Plus skin with the entitlement -> 200", async () => {
    const { slug, cookie } = await createHostedBoard();
    expect((await postPlus(slug, { plan: "board" }, cookie)).status).toBe(200);
    const res = await patchSkin(slug, { skinId: "postcard" }, cookie);
    expect(res.status).toBe(200);
    expect(await getBoard(slug)).toMatchObject({ themeId: "postcard" });
  });
});

describe("POST /api/boards/[slug]/plus, PLUS_MODE=mock (PIN-103)", () => {
  it("invalid slug 404; missing host cookie 403; bad plan 400", async () => {
    const { slug, cookie } = await createHostedBoard();
    const bad = await postPlus("a/b", { plan: "board" }, cookie);
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: "Not found." });
    const anon = await postPlus(slug, { plan: "board" });
    expect(anon.status).toBe(403);
    expect(await anon.json()).toMatchObject({ code: "host_only" });
    const plan = await postPlus(slug, { plan: "lifetime" }, cookie);
    expect(plan.status).toBe(400);
    expect(await plan.json()).toMatchObject({ code: "plan_unknown" });
    expect(await getBoard(slug)).not.toHaveProperty("plus");
  });

  it("mock grants at once and the entitlement is persisted", async () => {
    const { slug, cookie } = await createHostedBoard();
    const res = await postPlus(slug, { plan: "host" }, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "granted",
      plus: {
        active: true,
        plan: "host",
        mode: "mock",
        priceLabels: { board: "$3.99", host: "$4.99/month" },
      },
    });
    expect((await getBoard(slug))?.plus).toMatchObject({ plan: "host", source: "mock" });
    expect((await view(slug)).plus).toMatchObject({ active: true, plan: "host" });
  });
});
