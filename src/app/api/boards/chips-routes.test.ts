import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Idea chips through the real handlers (PIN-214), memory backends,
 * AI_MOCK=1: the chips route hands the request's language to the
 * chips service, so the mock suggester answers in it and each
 * language gets its own cache entry. getLocale() is stubbed (it
 * reads next/headers), and de.json is stubbed because the
 * translate run has not filled make.chip.* yet (never edit it by
 * hand). Env is set BEFORE the route modules first read config.
 */
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-32";
process.env.AI_MOCK = "1";
process.env.DATA_BACKEND = "memory";

const locale = vi.hoisted(() => ({ current: vi.fn(async (): Promise<string> => "de") }));
const DE_CHIPS = vi.hoisted(() => ({
  "make.chip.picnic": "auf einer sonnigen Picknickdecke",
  "make.chip.museum": "in einem winzigen Museum",
  "make.chip.space": "schwebend im Weltall",
  "make.chip.party": "auf einer Geburtstagsparty",
}));
vi.mock("../../../i18n/server", () => ({ getLocale: locale.current }));
vi.mock("../../../i18n/messages/de.json", () => ({ default: DE_CHIPS }));

type Handler = (request: Request) => Promise<Response>;
type SlugHandler = (request: Request, context: { params: Promise<{ slug: string }> }) => Promise<Response>;
let createBoardRoute: Handler;
let joinRoute: SlugHandler;
let uploadRoute: SlugHandler;
let confirmRoute: SlugHandler;
let chipsRoute: SlugHandler;

beforeAll(async () => {
  ({ POST: createBoardRoute } = await import("./route"));
  ({ POST: joinRoute } = await import("./[slug]/participants/route"));
  ({ POST: uploadRoute } = await import("./[slug]/photos/route"));
  ({ POST: confirmRoute } = await import("./[slug]/pins/confirm/route"));
  ({ POST: chipsRoute } = await import("./[slug]/chips/route"));
});

beforeEach(() => {
  locale.current.mockReset();
  locale.current.mockResolvedValue("de");
});

let ipSeq = 0;
const ip = () => `10.214.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

async function newBoard(): Promise<string> {
  const res = await createBoardRoute(
    new Request("http://t/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ title: "Chips board" }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { board: { slug: string } }).board.slug;
}

async function join(slug: string): Promise<string> {
  const res = await joinRoute(
    new Request("http://t/x", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ displayName: "Robin" }),
    }),
    params(slug),
  );
  expect(res.status).toBe(201);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

/** One photo through the mock decompose, every pin kept; returns the pinned element ids. */
async function pinPhoto(slug: string, cookie: string): Promise<string[]> {
  const png = await sharp({
    create: { width: 320, height: 334, channels: 3, background: { r: 80, g: 120, b: 140 } },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.set("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "photo.png");
  const encoded = new Response(form);
  const body = new Uint8Array(await encoded.arrayBuffer());
  const uploaded = await uploadRoute(
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
  expect(uploaded.status).toBe(201);
  const { job } = (await uploaded.json()) as { job: { id: string; pinIds: string[]; elementIds: string[] } };
  const confirmed = await confirmRoute(
    new Request("http://t/x", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ jobId: job.id, pinIds: job.pinIds }),
    }),
    params(slug),
  );
  expect(confirmed.status).toBe(200);
  return job.elementIds;
}

async function chips(slug: string, cookie: string, elementIds: string[]) {
  const res = await chipsRoute(
    new Request("http://t/x", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ elementIds }),
    }),
    params(slug),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { chips: string[]; source: string };
}

describe("chips route follows the request's language (PIN-214)", () => {
  it("answers a German request in German, an English one in English, each cached on its own", async () => {
    const slug = await newBoard();
    const cookie = await join(slug);
    const elementIds = (await pinPhoto(slug, cookie)).slice(0, 2);

    expect(await chips(slug, cookie, elementIds)).toEqual({
      chips: Object.values(DE_CHIPS),
      source: "generated",
    });
    expect(await chips(slug, cookie, elementIds)).toMatchObject({ source: "cache" });

    // Same picks in English: its own entry, generated in English.
    locale.current.mockResolvedValue("en");
    expect(await chips(slug, cookie, elementIds)).toEqual({
      chips: ["on a sunny picnic blanket", "in a tiny museum", "floating in space", "at a birthday party"],
      source: "generated",
    });
  });
});
