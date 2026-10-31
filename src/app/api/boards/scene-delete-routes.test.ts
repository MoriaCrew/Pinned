import { beforeAll, describe, expect, it } from "vitest";
import type { Scene } from "../../../domain/board";
import { t } from "../../../i18n";
import { resolvePolicy } from "../../../policy/policy";

/**
 * Scene delete through the real handlers (PIN-142), memory backends.
 * Env is set BEFORE the route modules first read config, so they are
 * imported dynamically (as in leftovers-routes.test.ts).
 */
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-32";
process.env.AI_MOCK = "1";
process.env.DATA_BACKEND = "memory";

type Route<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;
type SceneP = { slug: string; sceneId: string };
let createBoardRoute: (request: Request) => Promise<Response>;
let getBoardRoute: Route<{ slug: string }>;
let joinRoute: Route<{ slug: string }>;
let getSceneRoute: Route<SceneP>;
let deleteSceneRoute: Route<SceneP>;
let sceneImageRoute: Route<SceneP>;
let repo: typeof import("../../../server/board-repository").getBoardRepository;
let store: typeof import("../../../server/derivative-store").getDerivativeStore;
let sceneJobs: typeof import("../../../server/scene-job-store").getSceneJobStore;

beforeAll(async () => {
  ({ POST: createBoardRoute } = await import("./route"));
  ({ GET: getBoardRoute } = await import("./[slug]/route"));
  ({ POST: joinRoute } = await import("./[slug]/participants/route"));
  ({ GET: getSceneRoute, DELETE: deleteSceneRoute } = await import("./[slug]/scenes/[sceneId]/route"));
  ({ GET: sceneImageRoute } = await import("./[slug]/scenes/[sceneId]/image/route"));
  ({ getBoardRepository: repo } = await import("../../../server/board-repository"));
  ({ getDerivativeStore: store } = await import("../../../server/derivative-store"));
  ({ getSceneJobStore: sceneJobs } = await import("../../../server/scene-job-store"));
});
let ipSeq = 0;
const ip = () => `10.142.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const NOT_FOUND = { error: "Not found." };
const at = (slug: string, sceneId: string) => ({ params: Promise.resolve({ slug, sceneId }) });
const post = (body: unknown) =>
  new Request("http://t/x", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip() },
    body: JSON.stringify(body),
  });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

async function newBoard(): Promise<{ slug: string; host: string }> {
  const res = await createBoardRoute(post({ title: "Delete board" }));
  const { board } = (await res.json()) as { board: { slug: string } };
  return { slug: board.slug, host: cookieOf(res) };
}

async function join(slug: string, displayName: string): Promise<{ id: string; cookie: string }> {
  const res = await joinRoute(post({ displayName }), { params: Promise.resolve({ slug }) });
  const { participant } = (await res.json()) as { participant: { id: string } };
  return { id: participant.id, cookie: cookieOf(res) };
}

/** A ready scene with its image stored at the real key shape; returns the ref. */
async function seedScene(slug: string, id: string, createdBy: string, extra: Partial<Scene> = {}): Promise<string> {
  const imageRef = `scenes/boards/${slug}/${id}/scene.png`;
  await store().put(imageRef, Buffer.from("png-bytes"), "image/png");
  await repo().putScene({
    id, boardId: slug, createdBy, elementIds: [], prompt: "a picnic", status: "ready",
    imageRef, promptVersion: "scene.v1", createdAt: Date.now(), ...extra,
  });
  return imageRef;
}

const del = (slug: string, sceneId: string, cookie?: string, headers: Record<string, string> = {}) =>
  deleteSceneRoute(new Request("http://t/x", { method: "DELETE", headers: { ...(cookie ? { cookie } : {}), ...headers } }), at(slug, sceneId));
const imageStatus = async (slug: string, id: string) => (await sceneImageRoute(new Request("http://t/x"), at(slug, id))).status;
async function expect404(res: Response) {
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual(NOT_FOUND);
}
async function boardView(slug: string, cookie?: string) {
  const res = await getBoardRoute(new Request("http://t/x", { headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ slug }) });
  return (await res.json()) as {
    scenes: { id: string; parentSceneId?: string; canDelete?: boolean; parentDeleted?: boolean }[];
    board: { counters: { sceneCount: number } };
    activity: { id: string }[];
  };
}

describe("DELETE /api/boards/{slug}/scenes/{sceneId} (PIN-142)", () => {
  it("the maker deletes: gone everywhere, object deleted, tombstone kept; a repeat is a no-op; a remix child stays", async () => {
    const { slug, host } = await newBoard();
    const robin = await join(slug, "Robin");
    const sam = await join(slug, "Sam");
    const id = `${slug}-parent`;
    const child = `${slug}-child`;
    const ref = await seedScene(slug, id, robin.id);
    await seedScene(slug, child, sam.id, { parentSceneId: id });
    expect(await imageStatus(slug, id)).toBe(200);
    expect((await del(slug, id, robin.cookie)).status).toBe(204);
    expect(await imageStatus(slug, id)).toBe(404);
    expect((await getSceneRoute(new Request("http://t/x"), at(slug, id))).status).toBe(404);
    expect(await store().get(ref)).toBeNull();
    expect(await repo().getScene(id)).toMatchObject({ hidden: true, deletedBy: "maker", deletedAt: expect.any(Number) });
    // Repeat: 204 for the maker and the host, the uniform 404 for anyone else.
    expect((await del(slug, id, robin.cookie)).status).toBe(204);
    expect((await del(slug, id, host)).status).toBe(204);
    await expect404(await del(slug, id, sam.cookie));
    expect((await repo().getScene(id))?.deletedBy).toBe("maker");
    // The count moved once; the remix child stays, its parent id intact.
    const view = await boardView(slug);
    expect(view.board.counters.sceneCount).toBe(1);
    expect(view.scenes).toEqual([expect.objectContaining({ id: child, parentSceneId: id })]);
    expect(await imageStatus(slug, child)).toBe(200);
  });

  it("the host deletes someone else's scene with the host cookie alone", async () => {
    const { slug, host } = await newBoard();
    const sam = await join(slug, "Sam");
    const id = `${slug}-host`;
    const ref = await seedScene(slug, id, sam.id);
    expect((await del(slug, id, host)).status).toBe(204);
    expect(await store().get(ref)).toBeNull();
    expect(await repo().getScene(id)).toMatchObject({ hidden: true, deletedBy: "host" });
  });

  it("everyone else gets the identical 404 body, a cross-site request a 403, and nothing changes", async () => {
    const { slug } = await newBoard();
    const other = await newBoard();
    const robin = await join(slug, "Robin");
    const sam = await join(slug, "Sam");
    const samThere = await join(other.slug, "Sam");
    const id = `${slug}-keep`;
    const ref = await seedScene(slug, id, robin.id);
    const misses: [string, string, string | undefined][] = [
      [slug, id, sam.cookie], // another participant
      [slug, id, undefined], // anonymous
      [slug, id, `pinned_player_${slug}=garbage; pinned_host_${slug}=h1.${"A".repeat(43)}`], // garbled cookies
      [slug, id, `pinned_host_${slug}=${other.host.split("=")[1]}`], // another board's host token
      [other.slug, id, other.host], // wrong board: that board's host
      [other.slug, id, samThere.cookie], // wrong board: that board's participant
      [slug, `${slug}-missing`, robin.cookie], // unknown id
      [slug, "a/b", robin.cookie], // malformed id (%2F decoded)
    ];
    for (const [s, sceneId, cookie] of misses) await expect404(await del(s, sceneId, cookie));
    expect((await del(slug, id, robin.cookie, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(await imageStatus(slug, id)).toBe(200);
    expect(await store().get(ref)).not.toBeNull();
    expect((await repo().getScene(id))?.hidden).toBeUndefined();
  });

  it("in flight (Scene or its job): 409 for the maker and host, the same 404 for anyone else", async () => {
    const { slug, host } = await newBoard();
    const robin = await join(slug, "Robin");
    const sam = await join(slug, "Sam");
    const developing = `${slug}-developing`;
    await seedScene(slug, developing, robin.id, { status: "running" });
    // The Scene lags its job by one write: a ready Scene whose job still runs.
    const lagging = `${slug}-lagging`;
    await seedScene(slug, lagging, robin.id);
    await sceneJobs().create({
      id: lagging, boardId: slug, participantId: robin.id, elementIds: [], prompt: "a picnic",
      status: "running", promptVersion: "scene.v1", createdAt: Date.now(), updatedAt: Date.now(),
    });
    for (const id of [developing, lagging]) {
      for (const cookie of [robin.cookie, host]) {
        const res = await del(slug, id, cookie);
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: t("en", "board.sceneDeleteDeveloping"), code: "scene_in_flight" });
      }
      await expect404(await del(slug, id, sam.cookie));
      expect((await repo().getScene(id))?.hidden).toBeUndefined();
    }
  });

  it("its activity line leaves the strip before the strip is cut to Policy.activityStripMax", async () => {
    const { slug } = await newBoard();
    const robin = await join(slug, "Robin");
    const max = resolvePolicy().activityStripMax;
    const ids = Array.from({ length: max + 1 }, (_, i) => `${slug}-line${i}`);
    for (const [i, id] of ids.entries()) {
      await seedScene(slug, id, robin.id);
      await repo().appendEvent({
        id: `scene-${id}-ready`, boardId: slug, type: "scene_ready", actorId: robin.id, sceneId: id, createdAt: Date.now() + i,
      });
    }
    const newest = `scene-${ids[max]}-ready`;
    expect((await boardView(slug)).activity.map((line) => line.id)).toContain(newest);
    expect((await del(slug, ids[max], robin.cookie)).status).toBe(204);
    const lines = (await boardView(slug)).activity.map((line) => line.id);
    expect(lines).not.toContain(newest);
    expect(lines).toHaveLength(max); // the freed slot is refilled, not lost
  });

  it("the board view flags canDelete for the maker and host only, and parentDeleted on a remix (PIN-143)", async () => {
    const { slug, host } = await newBoard();
    const robin = await join(slug, "Robin");
    const sam = await join(slug, "Sam");
    const parent = `${slug}-flag-parent`;
    const child = `${slug}-flag-child`;
    await seedScene(slug, parent, robin.id);
    await seedScene(slug, child, sam.id, { parentSceneId: parent });
    const flags = async (cookie?: string) =>
      Object.fromEntries((await boardView(slug, cookie)).scenes.map((s) => [s.id, s.canDelete]));
    expect(await flags(robin.cookie)).toEqual({ [parent]: true, [child]: false });
    expect(await flags(sam.cookie)).toEqual({ [parent]: false, [child]: true });
    expect(await flags(host)).toEqual({ [parent]: true, [child]: true });
    expect(await flags()).toEqual({ [parent]: false, [child]: false });
    expect((await boardView(slug)).scenes.find((s) => s.id === child)).not.toHaveProperty("parentDeleted");
    expect((await del(slug, parent, robin.cookie)).status).toBe(204);
    expect((await boardView(slug)).scenes).toEqual([expect.objectContaining({ id: child, parentDeleted: true })]);
  });
});
