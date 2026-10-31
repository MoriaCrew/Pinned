import { beforeAll, describe, expect, it } from "vitest";
import { PLUS_SKIN_IDS } from "../../../domain/plus";
import { generateAdminToken, generateSlug } from "../../../domain/tokens";

/**
 * Board Plus routes, PLUS_MODE=mock (PIN-103): real handlers on the
 * memory backends with AI_MOCK=1 and the real skin registry. Env is
 * set BEFORE the route modules first read config, so handlers are
 * imported dynamically (as in auth-routes.optional.test.ts). Every
 * request gets its own client IP unless a test pins one, so the
 * small per-IP budget below only bites in the rate-limit test.
 * The off-mode twin lives in plus-routes.off.test.ts.
 */
process.env.PLUS_MODE = "mock";
process.env.AI_MOCK = "1";
process.env.DATA_BACKEND = "memory";
process.env.SESSION_SECRET = "s".repeat(40);
process.env.POLICY_OVERRIDES_JSON = JSON.stringify({
  plus: { hostRoutesPerIp: { limit: 3, windowMs: 600_000 }, requestMaxBytes: 256 },
});

const PLUS_SKIN = PLUS_SKIN_IDS[0];
const FREE_SKIN = "cork";

type SlugHandler = (
  request: Request,
  context: { params: Promise<{ slug: string }> },
) => Promise<Response>;
type StoredBoard = {
  themeId?: string;
  plus?: unknown;
  host?: { tokenHash: string; issuedAt: number };
  version: number;
};

let createBoardRoute: (request: Request) => Promise<Response>;
let getBoardRoute: SlugHandler;
let skinRoute: SlugHandler;
let plusRoute: SlugHandler;
let joinRoute: SlugHandler;
let getBoard: (slug: string) => Promise<StoredBoard | null>;

beforeAll(async () => {
  ({ POST: createBoardRoute } = await import("./route"));
  ({ GET: getBoardRoute } = await import("./[slug]/route"));
  ({ PATCH: skinRoute } = await import("./[slug]/skin/route"));
  ({ POST: plusRoute } = await import("./[slug]/plus/route"));
  ({ POST: joinRoute } = await import("./[slug]/participants/route"));
  const { getBoardRepository } = await import("../../../server/board-repository");
  getBoard = (slug) => getBoardRepository().getBoard(slug) as Promise<StoredBoard | null>;
});

let ipSeq = 0;
const freshIp = () => `10.103.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

async function createBoard(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return createBoardRoute(
    new Request("http://t/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": freshIp(), ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function createHostedBoard(headers: Record<string, string> = {}) {
  const res = await createBoard({ title: "Plus route board" }, headers);
  expect(res.status).toBe(201);
  const { board } = (await res.json()) as { board: { slug: string } };
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { slug: board.slug, cookie: setCookie.split(";")[0], setCookie };
}

/** Join as a board participant; returns the board session cookie pair. */
async function joinedCookie(slug: string): Promise<string> {
  const res = await joinRoute(
    new Request(`http://t/api/boards/${slug}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ displayName: "Member" }),
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

function send(handler: SlugHandler, method: string, slug: string, body: unknown, opts: Send = {}) {
  return handler(
    new Request(`http://t/api/boards/${slug}/x`, {
      method,
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
const patchSkin = (slug: string, body: unknown, opts?: Send) => send(skinRoute, "PATCH", slug, body, opts);
const postPlus = (slug: string, body: unknown, opts?: Send) => send(plusRoute, "POST", slug, body, opts);

async function view(slug: string, cookie?: string) {
  const res = await getBoardRoute(
    new Request(`http://t/api/boards/${slug}`, { headers: cookie ? { cookie } : {} }),
    params(slug),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    board: { themeId: string | null };
    viewer: { isHost: boolean; canChangeLook: boolean };
    plus: { active: boolean; plan?: string; mode: string };
  };
}

async function expectRefused(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toMatchObject({ code });
}

describe("host cookie on board creation (PIN-103)", () => {
  it("sets a versioned random token, Path-scoped to the board API; stores only its hash", async () => {
    const { slug, setCookie } = await createHostedBoard();
    const match = setCookie.match(new RegExp(`^pinned_host_${slug}=h1\\.([A-Za-z0-9_-]{43}); `));
    expect(match).not.toBeNull();
    expect(setCookie).toContain(`Path=/api/boards/${slug};`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain(`Max-Age=${365 * 24 * 60 * 60}`);
    expect(setCookie).not.toContain("Secure");
    const stored = await getBoard(slug);
    expect(stored?.host?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(match![1]);
    const https = await createHostedBoard({ "x-forwarded-proto": "https" });
    expect(https.setCookie).toContain("Secure");
  });

  it("a Plus skin as the initial theme is 402 plus_required (real registry)", async () => {
    await expectRefused(await createBoard({ title: "Sneaky", themeId: PLUS_SKIN }), 402, "plus_required");
    expect((await createBoard({ title: "Free", themeId: FREE_SKIN })).status).toBe(201);
  });

  it("board view: isHost only with this board's cookie; never leaks the hash", async () => {
    const a = await createHostedBoard();
    const b = await createHostedBoard();
    const asHost = await view(a.slug, a.cookie);
    expect(asHost.viewer).toEqual({ isHost: true, canChangeLook: true });
    expect(asHost.plus).toEqual({ active: false, mode: "mock" });
    expect(JSON.stringify(asHost)).not.toMatch(/tokenHash|issuedAt/);
    expect((await view(a.slug)).viewer).toEqual({ isHost: false, canChangeLook: false });
    expect((await view(a.slug, b.cookie)).viewer).toEqual({ isHost: false, canChangeLook: false });
  });
});

describe("PATCH /api/boards/[slug]/skin (PIN-103)", () => {
  it("invalid slug -> uniform 404", async () => {
    for (const slug of ["a/b", "short", "..%2f.."]) {
      const res = await patchSkin(slug, { skinId: FREE_SKIN });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found." });
    }
  });

  it("request guards: cross-site 403, non-JSON 415, oversized body 413", async () => {
    const { slug, cookie } = await createHostedBoard();
    for (const site of ["cross-site", "same-site", "none"]) {
      await expectRefused(
        await patchSkin(slug, { skinId: FREE_SKIN }, { cookie, headers: { "sec-fetch-site": site } }),
        403,
        "cross_site",
      );
    }
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      await expectRefused(
        await patchSkin(slug, null, { cookie, headers: { "content-type": type }, raw: "skinId=cork" }),
        415,
        "unsupported_media_type",
      );
    }
    await expectRefused(
      await patchSkin(slug, { skinId: FREE_SKIN, pad: "x".repeat(300) }, { cookie }),
      413,
      "body_too_large",
    );
    const ok = await patchSkin(slug, { skinId: FREE_SKIN }, {
      cookie,
      headers: { "sec-fetch-site": "same-origin", "content-type": "application/json; charset=utf-8" },
    });
    expect(ok.status).toBe(200);
  });

  it("no, malformed or another board's host cookie, and unknown boards -> 403", async () => {
    const a = await createHostedBoard();
    const b = await createHostedBoard();
    const forged = `pinned_host_${a.slug}=h1.${generateAdminToken()}`;
    const responses = [
      await patchSkin(a.slug, { skinId: FREE_SKIN }),
      await patchSkin(a.slug, { skinId: FREE_SKIN }, { cookie: `pinned_host_${a.slug}=garbage` }),
      await patchSkin(a.slug, { skinId: FREE_SKIN }, { cookie: forged }),
      await patchSkin(a.slug, { skinId: FREE_SKIN }, { cookie: b.cookie }),
      await patchSkin(generateSlug(), { skinId: FREE_SKIN }, { cookie: a.cookie }),
    ];
    for (const res of responses) await expectRefused(res, 403, "host_only");
    expect((await getBoard(a.slug))?.version).toBe(1);
  });

  it("unknown skin -> 400", async () => {
    const { slug, cookie } = await createHostedBoard();
    await expectRefused(await patchSkin(slug, { skinId: "velvet" }, { cookie }), 400, "skin_unknown");
  });

  it("Plus skin without the entitlement -> 402 plus_required, nothing written", async () => {
    const { slug, cookie } = await createHostedBoard();
    const res = await patchSkin(slug, { skinId: PLUS_SKIN }, { cookie });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("plus_required");
    expect(body.error.length).toBeGreaterThan(0);
    expect(await getBoard(slug)).toMatchObject({ version: 1 });
    expect((await getBoard(slug))?.themeId).toBeUndefined();
  });

  it("free skin -> 200 and persisted; the same skin again is a no-op", async () => {
    const { slug, cookie } = await createHostedBoard();
    const res = await patchSkin(slug, { skinId: FREE_SKIN }, { cookie });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { board: { themeId: string } }).board.themeId).toBe(FREE_SKIN);
    expect(await getBoard(slug)).toMatchObject({ themeId: FREE_SKIN, version: 2 });
    expect((await view(slug)).board.themeId).toBe(FREE_SKIN);
    expect((await patchSkin(slug, { skinId: FREE_SKIN }, { cookie })).status).toBe(200);
    expect((await getBoard(slug))?.version).toBe(2);
  });

  it("Plus skin with the entitlement -> 200", async () => {
    const { slug, cookie } = await createHostedBoard();
    expect((await postPlus(slug, { plan: "board" }, { cookie })).status).toBe(200);
    const res = await patchSkin(slug, { skinId: PLUS_SKIN }, { cookie });
    expect(res.status).toBe(200);
    expect(await getBoard(slug)).toMatchObject({ themeId: PLUS_SKIN });
  });

  it("a joined member changes the look only while the board has Plus (PIN-181)", async () => {
    const { slug, cookie } = await createHostedBoard();
    const member = await joinedCookie(slug);
    const before = (await getBoard(slug))!.version;
    // No Plus: the member gets the same 403 as no credential; nothing written.
    await expectRefused(await patchSkin(slug, { skinId: FREE_SKIN }, { cookie: member }), 403, "host_only");
    expect((await getBoard(slug))?.version).toBe(before);
    expect((await view(slug, member)).viewer).toEqual({ isHost: false, canChangeLook: false });

    expect((await postPlus(slug, { plan: "board" }, { cookie })).status).toBe(200);
    expect((await view(slug, member)).viewer).toEqual({ isHost: false, canChangeLook: true });
    expect((await patchSkin(slug, { skinId: PLUS_SKIN }, { cookie: member })).status).toBe(200);
    expect(await getBoard(slug)).toMatchObject({ themeId: PLUS_SKIN });
    expect((await patchSkin(slug, { skinId: FREE_SKIN }, { cookie: member })).status).toBe(200);

    // Another board's member, and a member cookie aimed at an unknown board: uniform 403.
    const other = await createHostedBoard();
    const outsider = (await joinedCookie(other.slug)).replace(other.slug, slug);
    const unknown = generateSlug();
    for (const res of [
      await patchSkin(slug, { skinId: FREE_SKIN }, { cookie: outsider }),
      await patchSkin(unknown, { skinId: FREE_SKIN }, { cookie: member.replace(slug, unknown) }),
    ]) {
      await expectRefused(res, 403, "host_only");
    }
    // Buying Plus stays host-only.
    await expectRefused(await postPlus(slug, { plan: "host" }, { cookie: member }), 403, "host_only");
  });
});

describe("POST /api/boards/[slug]/plus, PLUS_MODE=mock (PIN-103)", () => {
  it("invalid slug 404; missing host cookie 403; bad plan 400", async () => {
    const { slug, cookie } = await createHostedBoard();
    const bad = await postPlus("a/b", { plan: "board" }, { cookie });
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: "Not found." });
    await expectRefused(await postPlus(slug, { plan: "board" }), 403, "host_only");
    await expectRefused(await postPlus(slug, { plan: "lifetime" }, { cookie }), 400, "plan_unknown");
    expect(await getBoard(slug)).not.toHaveProperty("plus");
  });

  it("mock grants at once and the entitlement is persisted", async () => {
    const { slug, cookie } = await createHostedBoard();
    const res = await postPlus(slug, { plan: "host" }, { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "granted",
      plus: { active: true, plan: "host", mode: "mock" },
    });
    expect((await getBoard(slug))?.plus).toMatchObject({ plan: "host", source: "mock" });
    expect((await view(slug)).plus).toMatchObject({ active: true, plan: "host" });
  });

  it("per-IP budget (Policy) is shared by both host routes -> 429", async () => {
    const { slug, cookie } = await createHostedBoard();
    const ip = freshIp();
    expect((await patchSkin(slug, { skinId: FREE_SKIN }, { cookie, ip })).status).toBe(200);
    expect((await postPlus(slug, { plan: "board" }, { cookie, ip })).status).toBe(200);
    await expectRefused(await patchSkin(slug, { skinId: "fridge" }, { ip }), 403, "host_only");
    await expectRefused(await postPlus(slug, { plan: "board" }, { cookie, ip }), 429, "rate_limited");
    await expectRefused(await patchSkin(slug, { skinId: "fridge" }, { cookie, ip }), 429, "rate_limited");
    expect((await patchSkin(slug, { skinId: "fridge" }, { cookie })).status).toBe(200);
  });
});
