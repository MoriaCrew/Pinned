import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * POST /api/boards/[slug]/report (PIN-270) through the real handlers,
 * memory backends, AI_MOCK=1: guards in order (slug, cross-site, JSON,
 * per-IP brake, body cap), typed 400s, the uniform 404, 201 with the
 * reference and `held`, and the 423 the write routes answer while a
 * board is under review. getLocale() is stubbed (it reads
 * next/headers). Env is set BEFORE the route modules first read config.
 */
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-32";
process.env.AI_MOCK = "1";
process.env.DATA_BACKEND = "memory";

vi.mock("../../../../../i18n/server", () => ({ getLocale: async (): Promise<string> => "en" }));

type Handler = (request: Request) => Promise<Response>;
type SlugHandler = (request: Request, context: { params: Promise<{ slug: string }> }) => Promise<Response>;
type TapHandler = (request: Request, context: { params: Promise<{ slug: string; jobId: string }> }) => Promise<Response>;

let route: Record<string, unknown>;
let reportRoute: SlugHandler;
let createBoardRoute: Handler;
let joinRoute: SlugHandler;
let boardViewRoute: SlugHandler;
let scenesRoute: SlugHandler;
let photosRoute: SlugHandler;
let tapAddRoute: TapHandler;
let getBoardRepository: typeof import("../../../../../server/board-repository").getBoardRepository;
let boardReportRef: typeof import("../../../../../domain/tokens").boardReportRef;

beforeAll(async () => {
  route = (await import("./route")) as unknown as Record<string, unknown>;
  reportRoute = route.POST as SlugHandler;
  ({ POST: createBoardRoute } = await import("../../route"));
  ({ POST: joinRoute } = await import("../participants/route"));
  ({ GET: boardViewRoute } = await import("../route"));
  ({ POST: scenesRoute } = await import("../scenes/route"));
  ({ POST: photosRoute } = await import("../photos/route"));
  ({ POST: tapAddRoute } = await import("../jobs/[jobId]/tap-add/route"));
  ({ getBoardRepository } = await import("../../../../../server/board-repository"));
  ({ boardReportRef } = await import("../../../../../domain/tokens"));
});

let ipSeq = 0;
const ip = () => `10.242.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

async function newBoard(): Promise<string> {
  const res = await createBoardRoute(
    new Request("http://t/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ title: "Report board" }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { board: { slug: string } }).board.slug;
}

async function join(slug: string): Promise<string> {
  const res = await joinRoute(
    new Request(`http://t/api/boards/${slug}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip(), "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ displayName: "Mia" }),
    }),
    params(slug),
  );
  expect(res.status).toBe(201);
  const cookie = res.headers.get("set-cookie");
  expect(cookie).not.toBeNull();
  return (cookie as string).split(";")[0];
}

async function seedElement(slug: string, id: string): Promise<void> {
  const boards = getBoardRepository();
  await boards.createElement({
    id, boardId: slug, ownerId: "p-seed", label: "teal mug", description: "", maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
    cutoutRef: `elements/boards/${slug}/${id}/cutout.png`, flattenedRef: `elements/boards/${slug}/${id}/flattened.jpg`,
    sourcePhotoId: "job", faceFlag: false, createdAt: 1_200,
  });
  await boards.putScene({
    id: `${id}-scene`, boardId: slug, createdBy: "p-seed", elementIds: [id], prompt: "x", status: "ready",
    imageRef: `scenes/boards/${slug}/${id}-scene/scene.webp`, promptVersion: "scene.v1", createdAt: 1_400,
  });
}

function report(slug: string, body: unknown, headers: Record<string, string> = {}, fromIp = ip()): Promise<Response> {
  return reportRoute(
    new Request(`http://t/api/boards/${slug}/report`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": fromIp, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    params(slug),
  );
}

describe("POST /api/boards/[slug]/report (PIN-270)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serves no GET", () => {
    expect(route.GET).toBeUndefined();
  });

  it("guards in order: bad slug 404, cross-site 403, non-JSON 415, body over the cap 413, bad body 400, unknown board 404", async () => {
    const slug = await newBoard();
    expect((await report("../etc", { scope: "board", reason: "likeness" })).status).toBe(404);
    const cross = await report(slug, { scope: "board", reason: "likeness" }, { "sec-fetch-site": "cross-site" });
    expect(cross.status).toBe(403);
    expect(await cross.json()).toMatchObject({ code: "cross_site" });
    expect((await report(slug, { scope: "board", reason: "likeness" }, { "content-type": "text/plain" })).status).toBe(415);
    const big = await report(slug, JSON.stringify({ scope: "board", reason: "likeness", message: "x".repeat(5000) }));
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ code: "body_too_large" });
    const bad = await report(slug, {});
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Pick what to report and why.", code: "report_invalid" });
    const noMessage = await report(slug, { scope: "board", reason: "other" });
    expect(await noMessage.json()).toMatchObject({ code: "report_message_required" });
    expect((await report(slug, "{nope")).status).toBe(400);
    expect((await report("ZyXwVuTsRqPoNmLkJiHgFe", { scope: "board", reason: "likeness" })).status).toBe(404);
  });

  it("brakes per address after Policy.report.perIp reports", async () => {
    const slug = await newBoard();
    const from = ip();
    for (let i = 0; i < 5; i++) {
      expect((await report(slug, { scope: "board", reason: "inappropriate" }, {}, from)).status).toBe(201);
    }
    const sixth = await report(slug, { scope: "board", reason: "inappropriate" }, {}, from);
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toMatchObject({ code: "rate_limited" });
  });

  it("a visitor's whole-board report is received, not held; the view stays open", async () => {
    const slug = await newBoard();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await report(slug, { scope: "board", reason: "inappropriate", reporterEmail: "a@b.co" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ reference: boardReportRef(slug), held: false });
    const view = await boardViewRoute(new Request(`http://t/api/boards/${slug}`), params(slug));
    expect(((await view.json()) as { board: { underReview: boolean } }).board.underReview).toBe(false);
    for (const call of log.mock.calls) expect(String(call[0])).not.toContain(slug);
  });

  it("an element report hides the pin's image and scene for everyone", async () => {
    const slug = await newBoard();
    await seedElement(slug, "el-1");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await report(slug, { scope: "element", targetId: "el-1", reason: "likeness" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ reference: boardReportRef(slug), held: true });
    const boards = getBoardRepository();
    expect((await boards.getElement("el-1"))?.cutoutRef).toBe(`held:elements/boards/${slug}/el-1/cutout.png`);
    expect(await boards.listScenes(slug)).toEqual([]);
    expect((await report(slug, { scope: "element", targetId: "ghost", reason: "likeness" })).status).toBe(404);
  });

  it("a participant's whole-board report pauses the board: 423 on photos, scenes and tap-add", async () => {
    const slug = await newBoard();
    const cookie = await join(slug);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await report(slug, { scope: "board", reason: "ownership" }, { cookie });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ reference: boardReportRef(slug), held: true });
    const view = await boardViewRoute(new Request(`http://t/api/boards/${slug}`, { headers: { cookie } }), params(slug));
    expect(((await view.json()) as { board: { underReview: boolean } }).board.underReview).toBe(true);

    const jsonPost = (path: string, body: unknown) =>
      new Request(`http://t/api/boards/${slug}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip(), cookie },
        body: JSON.stringify(body),
      });
    const scene = await scenesRoute(jsonPost("scenes", { elementIds: ["el-1"], prompt: "hi" }), params(slug));
    expect(scene.status).toBe(423);
    expect(await scene.json()).toEqual({ error: "This board is paused while we check a report.", code: "board_under_review" });
    const tap = await tapAddRoute(jsonPost("jobs/job-1/tap-add", { x: 0.5, y: 0.5 }), { params: Promise.resolve({ slug, jobId: "job-1" }) });
    expect(tap.status).toBe(423);
    const photo = await photosRoute(
      new Request(`http://t/api/boards/${slug}/photos`, { method: "POST", headers: { "x-forwarded-for": ip(), cookie } }),
      params(slug),
    );
    expect(photo.status).toBe(423);
  });
});
