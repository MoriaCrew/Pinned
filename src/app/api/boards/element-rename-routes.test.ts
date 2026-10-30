import { beforeAll, describe, expect, it } from "vitest";
import { sceneCredits, thingInSentence } from "../../../domain/board-ui";
import type { BoardViewLike } from "../../../domain/board-view";
import { generateSlug } from "../../../domain/tokens";
import { DEFAULT_POLICY } from "../../../policy/policy";

/**
 * Element rename through the real handlers (PIN-156), memory backends.
 * Env is set BEFORE the route modules first read config, so they are
 * imported dynamically (as in scene-delete-routes.test.ts).
 */
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-32";
process.env.AI_MOCK = "1";
process.env.DATA_BACKEND = "memory";

type Route<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;
type ElementP = { slug: string; elementId: string };
let createBoardRoute: (request: Request) => Promise<Response>;
let getBoardRoute: Route<{ slug: string }>;
let joinRoute: Route<{ slug: string }>;
let patchRoute: Route<ElementP>;
let repo: typeof import("../../../server/board-repository").getBoardRepository;

beforeAll(async () => {
  ({ POST: createBoardRoute } = await import("./route"));
  ({ GET: getBoardRoute } = await import("./[slug]/route"));
  ({ POST: joinRoute } = await import("./[slug]/participants/route"));
  ({ PATCH: patchRoute } = await import("./[slug]/elements/[elementId]/route"));
  ({ getBoardRepository: repo } = await import("../../../server/board-repository"));
});
let ipSeq = 0;
const ip = () => `10.156.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const CAP = DEFAULT_POLICY.elementLabelMaxChars;
const JSON_TYPE = { "content-type": "application/json" };
const post = (body: unknown) =>
  new Request("http://t/x", { method: "POST", headers: { ...JSON_TYPE, "x-forwarded-for": ip() }, body: JSON.stringify(body) });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

async function newBoard(): Promise<string> {
  const res = await createBoardRoute(post({ title: "Rename board" }));
  return ((await res.json()) as { board: { slug: string } }).board.slug;
}

async function join(slug: string, displayName: string): Promise<{ id: string; cookie: string }> {
  const res = await joinRoute(post({ displayName }), { params: Promise.resolve({ slug }) });
  const { participant } = (await res.json()) as { participant: { id: string } };
  return { id: participant.id, cookie: cookieOf(res) };
}

/** A pinned thing (only pinned things are in the board view) and a scene that uses it. */
async function seedThing(slug: string, ownerId: string): Promise<string> {
  const id = `${slug}-el`;
  const createdAt = Date.now();
  await repo().createElement({
    id, boardId: slug, ownerId, label: "my thing", description: "a lamp", maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
    cutoutRef: `elements/boards/${slug}/${id}/cutout.png`, flattenedRef: `elements/boards/${slug}/${id}/flattened.jpg`,
    sourcePhotoId: "job-1", faceFlag: false, createdAt,
  });
  await repo().createPin({ id: `${id}-pin`, boardId: slug, elementId: id, pinnedBy: ownerId, status: "pinned", createdAt });
  await repo().putScene({
    id: `${slug}-scene`, boardId: slug, createdBy: ownerId, elementIds: [id], prompt: "a picnic", status: "ready",
    imageRef: `scenes/boards/${slug}/${slug}-scene/scene.png`, promptVersion: "scene.v1", createdAt,
  });
  return id;
}

function patch(slug: string, elementId: string, body: unknown, cookie?: string, headers: Record<string, string> = JSON_TYPE) {
  const init = { method: "PATCH", headers: { ...(cookie ? { cookie } : {}), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) };
  return patchRoute(new Request("http://t/x", init), { params: Promise.resolve({ slug, elementId }) });
}

const labelOf = async (id: string) => (await repo().getElement(id))?.label;
const headersOf = (res: Response) => [...res.headers.entries()].sort();

describe("PATCH /api/boards/{slug}/elements/{elementId} (PIN-156)", () => {
  it("the owner renames: 200 with the public element; the grid and an old scene's credits read the new name", async () => {
    const slug = await newBoard();
    const robin = await join(slug, "Robin");
    const id = await seedThing(slug, robin.id);
    const res = await patch(slug, id, { label: "  Brass \n desk   lamp " }, robin.cookie, { ...JSON_TYPE, "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      element: expect.objectContaining({ id, ownerId: robin.id, label: "Brass desk lamp", imageUrl: expect.stringContaining(id) }),
    });
    expect(await labelOf(id)).toBe("Brass desk lamp");
    const view = (await (await getBoardRoute(new Request("http://t/x"), { params: Promise.resolve({ slug }) })).json()) as BoardViewLike & {
      scenes: { elementIds: string[] }[];
      participants: { id: string; displayName: string }[];
    };
    expect(view.elements.find((e) => e.id === id)?.label).toBe("Brass desk lamp");
    // Scenes store only elementIds, so a scene made before the rename credits the new name.
    expect(sceneCredits(view.scenes[0], view.elements, view.participants).map((c) => c.thing)).toEqual([
      thingInSentence("Brass desk lamp"),
    ]);
  });

  it("everyone else gets the identical 404 (status, body, headers), even with an empty label, and nothing changes", async () => {
    const slug = await newBoard();
    const other = await newBoard();
    const robin = await join(slug, "Robin");
    const sam = await join(slug, "Sam");
    const samThere = await join(other, "Sam");
    const id = await seedThing(slug, robin.id);
    const misses: [string, string, string | undefined, unknown][] = [
      [slug, id, sam.cookie, { label: "Mine now" }], // another participant
      [slug, id, sam.cookie, { label: "" }], // another participant, invalid label: still 404, never 400
      [slug, id, undefined, { label: "Mine now" }], // anonymous
      [slug, id, `pinned_player_${slug}=garbage`, { label: "Mine now" }], // garbled cookie
      [other, id, samThere.cookie, { label: "Mine now" }], // wrong board: that board's participant
      [other, id, robin.cookie, { label: "Mine now" }], // wrong board: the owner's cookie does not reach it
      [generateSlug(), id, robin.cookie, { label: "Mine now" }], // no such board
      [slug, `${slug}-missing`, robin.cookie, { label: "Mine now" }], // unknown id
      ["a/b", id, robin.cookie, { label: "Mine now" }], // malformed slug (%2F decoded)
    ];
    const baseline = await patch(slug, `${slug}-missing`, { label: "x" }, robin.cookie);
    const baselineHeaders = headersOf(baseline);
    for (const [s, elementId, cookie, body] of misses) {
      const res = await patch(s, elementId, body, cookie);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found." });
      expect(headersOf(res)).toEqual(baselineHeaders);
    }
    expect(await labelOf(id)).toBe("my thing");
  });

  it("guards answer before any lookup, the same for the owner and an unknown id: cross-site 403, non-JSON 415, oversized 413", async () => {
    const slug = await newBoard();
    const robin = await join(slug, "Robin");
    const id = await seedThing(slug, robin.id);
    const oversized = { label: "Lamp", pad: "x".repeat(DEFAULT_POLICY.elementRenameMaxBytes) };
    for (const elementId of [id, `${slug}-missing`]) {
      const crossSite = await patch(slug, elementId, { label: "Lamp" }, robin.cookie, { ...JSON_TYPE, "sec-fetch-site": "cross-site" });
      expect(crossSite.status).toBe(403);
      expect(await crossSite.json()).toMatchObject({ code: "cross_site" });
      // Cross-site beats the content type; the content type beats the size.
      expect((await patch(slug, elementId, "label=Lamp", robin.cookie, { "content-type": "text/plain", "sec-fetch-site": "cross-site" })).status).toBe(403);
      const nonJson = await patch(slug, elementId, "label=Lamp", robin.cookie, { "content-type": "text/plain" });
      expect(nonJson.status).toBe(415);
      expect(await nonJson.json()).toMatchObject({ code: "unsupported_media_type" });
      expect((await patch(slug, elementId, JSON.stringify(oversized), robin.cookie, { "content-type": "text/plain" })).status).toBe(415);
      const tooLarge = await patch(slug, elementId, oversized, robin.cookie);
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.json()).toMatchObject({ code: "body_too_large" });
    }
    expect(await labelOf(id)).toBe("my thing");
  });

  it("the owner gets 400 for an empty, over-cap, control-character or missing label; the label stays", async () => {
    const slug = await newBoard();
    const robin = await join(slug, "Robin");
    const id = await seedThing(slug, robin.id);
    const bad: unknown[] = [{ label: "" }, { label: " \n " }, { label: "a".repeat(CAP + 1) }, { label: "lamp\u0000" }, {}, { label: 7 }, "\"lamp\"", "{"];
    for (const body of bad) {
      const res = await patch(slug, id, body, robin.cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: `Give it a name up to ${CAP} characters.` });
    }
    expect(await labelOf(id)).toBe("my thing");
    // Exactly the cap is fine.
    expect((await patch(slug, id, { label: "a".repeat(CAP) }, robin.cookie)).status).toBe(200);
  });
});
