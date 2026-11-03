import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

/**
 * POST /api/demo (PIN-251): a same-origin form post gets a redirect to
 * a fresh demo board with the host cookie; every refusal is a redirect
 * back to the landing with a notice (never a JSON page for a form), a
 * cross-site post is the uniform 403, and GET does not exist. Memory
 * backends, AI_MOCK default.
 */
const state = vi.hoisted(() => ({ template: null as string | null }));

vi.mock("../../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config")>();
  return {
    ...actual,
    getConfig: () => ({
      ...actual.getConfig(),
      demoBoardSlug: state.template,
      // One demo board per address, three in all: enough to see both caps.
      policyOverridesJson: JSON.stringify({ demo: { maxPerIp: 1, maxTotal: 3 } }),
    }),
  };
});

const route = await import("./route");
const { GET: getBoardRoute } = await import("../boards/[slug]/route");
const { getBoardRepository } = await import("../../../server/board-repository");
const { getDerivativeStore } = await import("../../../server/derivative-store");
const { emptyBoardCounters } = await import("../../../domain/board");
const { generateSlug, isValidSlug } = await import("../../../domain/tokens");

async function seedTemplate(): Promise<string> {
  const slug = generateSlug();
  const boards = getBoardRepository();
  const store = getDerivativeStore();
  await boards.createBoard({ slug, title: "Template", counters: emptyBoardCounters(), createdAt: 1_000, version: 1 });
  await boards.putParticipant({ id: `${slug}-p1`, boardId: slug, displayName: "Demo Mia", cookieSecretHash: "h", createdAt: 1_100 });
  const cutoutRef = `elements/boards/${slug}/e1/cutout.png`;
  await store.put(cutoutRef, Buffer.from("cutout"), "image/png");
  await boards.createElement({
    id: `${slug}-e1`, boardId: slug, ownerId: `${slug}-p1`, label: "teal mug", description: "a mug", maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
    cutoutRef, flattenedRef: `elements/boards/${slug}/e1/flattened.jpg`, sourcePhotoId: "job", faceFlag: false, createdAt: 1_200,
  });
  await boards.createPin({ id: `${slug}-pin1`, boardId: slug, elementId: `${slug}-e1`, pinnedBy: `${slug}-p1`, status: "pinned", createdAt: 1_300 });
  const imageRef = `scenes/boards/${slug}/${slug}-s1/scene.png`;
  await store.put(imageRef, Buffer.from("scene"), "image/png");
  await boards.putScene({
    id: `${slug}-s1`, boardId: slug, createdBy: `${slug}-p1`, elementIds: [`${slug}-e1`], prompt: "tea", status: "ready",
    imageRef, promptVersion: "scene.v1", kind: "collage", collageReason: "mock", createdAt: 1_400,
  });
  return slug;
}

let ipSeq = 0;
function post(ip = `10.0.${++ipSeq}.1`, headers: Record<string, string> = {}): Request {
  return new Request("http://t/api/demo", {
    method: "POST",
    headers: { "x-forwarded-for": ip, "sec-fetch-site": "same-origin", ...headers },
  });
}

function slugOf(location: string | null): string {
  const match = /^\/g\/([A-Za-z0-9_-]{22})$/.exec(location ?? "");
  expect(match, `location ${location}`).not.toBeNull();
  return match![1];
}

describe("POST /api/demo (PIN-251)", () => {
  beforeEach(() => {
    state.template = null;
  });

  it("serves no GET", () => {
    expect((route as Record<string, unknown>).GET).toBeUndefined();
  });

  it("refuses a cross-site post with the uniform 403", async () => {
    state.template = await seedTemplate();
    const res = await route.POST(post(undefined, { "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cross_site" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sends the visitor back with a notice when no template is configured or it is missing", async () => {
    const res = await route.POST(post());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?demo=unavailable");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");

    state.template = generateSlug(); // configured, but no such board
    const missing = await route.POST(post());
    expect(missing.status).toBe(303);
    expect(missing.headers.get("location")).toBe("/?demo=unavailable");
  });

  it("creates a fresh demo board, redirects to it with the host cookie, and the board serves", async () => {
    state.template = await seedTemplate();
    const res = await route.POST(post());
    expect(res.status).toBe(303);
    const slug = slugOf(res.headers.get("location"));
    expect(isValidSlug(slug)).toBe(true);
    expect(slug).not.toBe(state.template);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`pinned_host_${slug}=`);
    expect(cookie).toContain(`Path=/api/boards/${slug}`);
    expect(cookie).toContain("HttpOnly");

    const view = await getBoardRoute(new Request(`http://t/api/boards/${slug}`), { params: Promise.resolve({ slug }) });
    expect(view.status).toBe(200);
    const body = (await view.json()) as { board: { slug: string; title: string }; participants: unknown[]; pins: unknown[]; scenes: unknown[] };
    expect(body.board).toMatchObject({ slug, title: "Demo board" });
    expect(body.participants).toHaveLength(1);
    expect(body.pins).toHaveLength(1);
    expect(body.scenes).toHaveLength(1);
    // Nothing server-only leaks through the public board.
    expect(body.board).not.toHaveProperty("demo");
    expect(body.board).not.toHaveProperty("demoSweepAt");
    expect(body.board).not.toHaveProperty("host");

    const again = await route.POST(post());
    expect(slugOf(again.headers.get("location"))).not.toBe(slug);
  });

  it("answers a reached cap with the busy notice: per address first, then the total", async () => {
    state.template = await seedTemplate();
    const first = await route.POST(post("10.9.0.1"));
    slugOf(first.headers.get("location"));
    const sameAddress = await route.POST(post("10.9.0.1"));
    expect(sameAddress.status).toBe(303);
    expect(sameAddress.headers.get("location")).toBe("/?demo=busy");
    expect(sameAddress.headers.get("set-cookie")).toBeNull();
    // The test above made two boards and this one a third: the total of three is spent (one
    // in-process allowance store per test file, tests in file order).
    const other = await route.POST(post("10.9.0.2"));
    expect(other.headers.get("location")).toBe("/?demo=busy");
    expect(await getBoardRepository().listDemoBoardsToSweep(Number.MAX_SAFE_INTEGER, 10)).toHaveLength(3);
  });
});
