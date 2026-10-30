import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Leftovers through the real handlers (PIN-122), memory backends,
 * AI_MOCK=1: the board view tags only the viewer's OWN candidate
 * pins with their photo's job id, and an empty confirm ("Clear")
 * drops them. Someone else's job stays the uniform 404 body. Env
 * is set BEFORE the route modules first read config, so handlers
 * are imported dynamically (as in plus-routes.test.ts).
 */
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-32";
process.env.AI_MOCK = "1";
process.env.DATA_BACKEND = "memory";

type Handler = (request: Request) => Promise<Response>;
type SlugHandler = (request: Request, context: { params: Promise<{ slug: string }> }) => Promise<Response>;
let createBoardRoute: Handler;
let getBoardRoute: SlugHandler;
let joinRoute: SlugHandler;
let uploadRoute: SlugHandler;
let confirmRoute: SlugHandler;

beforeAll(async () => {
  ({ POST: createBoardRoute } = await import("./route"));
  ({ GET: getBoardRoute } = await import("./[slug]/route"));
  ({ POST: joinRoute } = await import("./[slug]/participants/route"));
  ({ POST: uploadRoute } = await import("./[slug]/photos/route"));
  ({ POST: confirmRoute } = await import("./[slug]/pins/confirm/route"));
});
let ipSeq = 0;
const ip = () => `10.122.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

interface ViewPin {
  id: string;
  status: "candidate" | "pinned";
  jobId?: string;
}

async function newBoard(): Promise<string> {
  const res = await createBoardRoute(
    new Request("http://t/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ title: "Leftovers board" }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { board: { slug: string } }).board.slug;
}

async function join(slug: string, displayName: string): Promise<string> {
  const res = await joinRoute(
    new Request("http://t/x", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ displayName }),
    }),
    params(slug),
  );
  expect(res.status).toBe(201);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function upload(slug: string, cookie: string): Promise<{ id: string; pinIds: string[] }> {
  const png = await sharp({
    create: { width: 320, height: 334, channels: 3, background: { r: 80, g: 120, b: 140 } },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.set("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "photo.png");
  const encoded = new Response(form);
  const body = new Uint8Array(await encoded.arrayBuffer());
  const res = await uploadRoute(
    new Request("http://t/x", {
      method: "POST",
      headers: {
        cookie,
        "x-forwarded-for": ip(),
        "content-type": encoded.headers.get("content-type") ?? "",
        "content-length": String(body.byteLength),
      },
      body,
    }),
    params(slug),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { job: { id: string; pinIds: string[] } }).job;
}

async function viewPins(slug: string, cookie?: string): Promise<ViewPin[]> {
  const res = await getBoardRoute(
    new Request("http://t/x", { headers: cookie ? { cookie } : {} }),
    params(slug),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { pins: ViewPin[] }).pins;
}

function confirm(slug: string, cookie: string, payload: unknown): Promise<Response> {
  return confirmRoute(
    new Request("http://t/x", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    params(slug),
  );
}

describe("leftovers routes (PIN-122)", () => {
  it("GET board: jobId on own candidates only, never on pinned pins or for others", async () => {
    const slug = await newBoard();
    const robin = await join(slug, "Robin");
    const sam = await join(slug, "Sam");
    const job = await upload(slug, robin);
    const keep = job.pinIds[0];
    const second = await upload(slug, robin);
    expect((await confirm(slug, robin, { jobId: job.id, pinIds: [keep] })).status).toBe(200);

    const mine = await viewPins(slug, robin);
    for (const pin of mine) {
      if (pin.status === "candidate") expect(pin.jobId).toBe(second.id);
      else expect(pin).not.toHaveProperty("jobId");
    }
    expect(mine.filter((pin) => pin.status === "candidate")).toHaveLength(second.pinIds.length);

    for (const pins of [await viewPins(slug, sam), await viewPins(slug)]) {
      expect(pins.map((pin) => pin.id)).toEqual([keep]);
      expect(pins[0]).not.toHaveProperty("jobId");
    }
  });

  it("POST confirm with none kept clears the leftovers; others get the uniform 404", async () => {
    const slug = await newBoard();
    const robin = await join(slug, "Robin");
    const sam = await join(slug, "Sam");
    const job = await upload(slug, robin);

    const denied = await confirm(slug, sam, { jobId: job.id, pinIds: [] });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "Not found." });
    expect((await viewPins(slug, robin)).length).toBe(job.pinIds.length);

    const cleared = await confirm(slug, robin, { jobId: job.id, pinIds: [] });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ pinnedPinIds: [], workingCopyDeleted: true });
    expect(await viewPins(slug, robin)).toEqual([]);
  });
});
