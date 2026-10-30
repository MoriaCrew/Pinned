import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { resolvePolicy } from "../../../policy/policy";

/**
 * Board delete through the real handlers (PIN-167), memory backends,
 * AI_MOCK=1 and AUTH_MODE=optional so claim, My boards and the
 * library run too. Env is set BEFORE the route modules first read
 * config, so they are imported dynamically.
 */
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-32";
process.env.AI_MOCK = "1";
process.env.DATA_BACKEND = "memory";
process.env.AUTH_MODE = "optional";

/** Route and store modules, loaded after the env above is set. */
const load = async () => ({
  create: await import("./route"),
  board: await import("./[slug]/route"),
  participants: await import("./[slug]/participants/route"),
  claim: await import("./[slug]/claim/route"),
  photos: await import("./[slug]/photos/route"),
  scenes: await import("./[slug]/scenes/route"),
  elementImage: await import("./[slug]/elements/[elementId]/image/route"),
  element: await import("./[slug]/elements/[elementId]/route"),
  sceneImage: await import("./[slug]/scenes/[sceneId]/image/route"),
  job: await import("./[slug]/jobs/[jobId]/route"),
  tap: await import("./[slug]/jobs/[jobId]/tap-add/route"),
  confirm: await import("./[slug]/pins/confirm/route"),
  transcribe: await import("./[slug]/transcribe/route"),
  fromLibrary: await import("./[slug]/pins/from-library/route"),
  skin: await import("./[slug]/skin/route"),
  session: await import("../auth/session/route"),
  myBoards: await import("../me/boards/route"),
  myImage: await import("../me/elements/[elementId]/image/route"),
  shared: await import("./shared"),
  api: await import("../../../server/board-api"),
  repos: await import("../../../server/board-repository"),
  users: await import("../../../server/user-repository"),
  jobs: await import("../../../server/decompose-job-store"),
  store: await import("../../../server/derivative-store"),
});
let m: Awaited<ReturnType<typeof load>>;

beforeAll(async () => {
  const { FakeTokenVerifier, setTokenVerifierForTests } = await import("../../../server/token-verifier");
  setTokenVerifierForTests(
    new FakeTokenVerifier({ "token-alice": { uid: "synthetic-alice" }, "token-bob": { uid: "synthetic-bob" } }),
  );
  m = await load();
});

let ipSeq = 0;
const ip = () => `10.167.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const UNKNOWN = "AAAAAAAAAAAAAAAAAAAAAQ"; // valid shape, never created
const NOT_FOUND = { error: "Not found." };
const p = <P>(params: P) => ({ params: Promise.resolve(params) });
const pair = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const repo = () => m.repos.getBoardRepository();
const users = () => m.users.getUserRepository();

/** Same-origin request from one fresh IP; a body makes it JSON. */
function req(cookie: string, init: { method?: string; body?: unknown; url?: string; headers?: Record<string, string> } = {}) {
  const json = init.body !== undefined;
  return new Request(init.url ?? "http://t/x", {
    method: init.method ?? "GET",
    headers: {
      cookie,
      "x-forwarded-for": ip(),
      "sec-fetch-site": "same-origin",
      ...(json ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    ...(json ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function signIn(idToken: string): Promise<string> {
  return pair(await m.session.POST(req("", { method: "POST", body: { idToken } })));
}

async function newBoard(): Promise<{ slug: string; host: string }> {
  const res = await m.create.POST(req("", { method: "POST", body: { title: "Delete me" } }));
  return { slug: ((await res.json()) as { board: { slug: string } }).board.slug, host: pair(res) };
}

async function join(slug: string, name: string, user = ""): Promise<{ id: string; cookie: string }> {
  const res = await m.participants.POST(req(user, { method: "POST", body: { displayName: name } }), p({ slug }));
  return { id: ((await res.json()) as { participant: { id: string } }).participant.id, cookie: pair(res) };
}

async function upload(slug: string, cookie: string): Promise<Response> {
  const png = await sharp({ create: { width: 320, height: 334, channels: 3, background: { r: 80, g: 120, b: 140 } } }).png().toBuffer();
  const form = new FormData();
  form.set("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "photo.png");
  const encoded = new Response(form);
  const body = new Uint8Array(await encoded.arrayBuffer());
  const headers = { "content-type": encoded.headers.get("content-type") ?? "", "content-length": String(body.byteLength) };
  return m.photos.POST(new Request(req(cookie, { method: "POST", headers }), { body }), p({ slug }));
}

const del = (slug: string, cookie: string, headers: Record<string, string> = {}) =>
  m.board.DELETE(req(cookie, { method: "DELETE", headers }), p({ slug }));

const store = () => m.store.getDerivativeStore();
/** Every stored object in the board's three folders (PIN-169). */
const objectsOf = async (slug: string) =>
  (await Promise.all(["tmp", "elements", "scenes"].map((root) => store().listPrefix(`${root}/boards/${slug}/`)))).flat();

const myBoards = async (user: string) =>
  ((await (await m.myBoards.GET(req(user))).json()) as { boards: { slug: string }[] }).boards.map((b) => b.slug);

describe("DELETE /api/boards/{slug} (PIN-167)", () => {
  it("the host deletes: every route then answers as for a slug that never existed and writes nothing", async () => {
    const alice = await signIn("token-alice");
    const bob = await signIn("token-bob");
    const { slug, host } = await newBoard();
    const robin = await join(slug, "Robin", alice); // signed in: auto-linked + indexed
    await join(slug, "Sam", bob);
    const { job } = (await (await upload(slug, robin.cookie)).json()) as { job: { id: string; pinIds: string[]; elementIds: string[] } };
    const elementId = job.elementIds[0];
    const sceneId = `${slug}-scene`;
    const imageRef = `scenes/boards/${slug}/${sceneId}/scene.png`;
    await m.store.getDerivativeStore().put(imageRef, Buffer.from("png-bytes"), "image/png");
    await repo().putScene({ id: sceneId, boardId: slug, createdBy: robin.id, elementIds: [], prompt: "a picnic", status: "ready", imageRef, promptVersion: "scene.v1", createdAt: Date.now() });
    const other = await newBoard();
    const robinThere = await join(other.slug, "Robin", alice);
    const myImage = (id: string) => m.myImage.GET(req(alice, { url: "http://t/x?kind=cutout" }), p({ elementId: id }));
    expect((await myImage(elementId)).status).toBe(200);
    expect(await myBoards(bob)).toContain(slug);

    const res = await del(slug, host);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(await users().getUserBoard("synthetic-alice", slug)).toBeNull();
    expect(await users().getUserBoard("synthetic-bob", slug)).toBeNull();
    expect(await myBoards(alice)).toEqual([other.slug]);
    expect(await myBoards(bob)).toEqual([]);
    expect(await m.api.getBoardView(slug, null, m.shared.boardApiDeps(resolvePolicy()))).toBeNull();

    const state = async () =>
      JSON.stringify(await Promise.all([
        repo().listParticipants(slug), repo().listElements(slug), repo().listPins(slug),
        repo().listScenes(slug, { includeHidden: true }), repo().listEvents(slug), m.jobs.getDecomposeJobStore().get(job.id),
        users().getUserBoard("synthetic-alice", slug), users().getUserBoard("synthetic-bob", slug),
      ]));
    const before = await state();
    const both = `${robin.cookie}; ${alice}`;
    const scene = { elementIds: [elementId], prompt: "late" };
    const calls: [string, (s: string) => Promise<Response>][] = [
      ["board GET", (s) => m.board.GET(req(both), p({ slug: s }))],
      ["board GET, user only", (s) => m.board.GET(req(alice), p({ slug: s }))],
      ["participants GET", (s) => m.participants.GET(req(robin.cookie), p({ slug: s }))],
      ["join", (s) => m.participants.POST(req(both, { method: "POST", body: { displayName: "Robin" } }), p({ slug: s }))],
      ["claim", (s) => m.claim.POST(req(both, { method: "POST" }), p({ slug: s }))],
      ["photos", (s) => upload(s, robin.cookie)],
      ["scenes GET", (s) => m.scenes.GET(req(""), p({ slug: s }))],
      ["scenes POST", (s) => m.scenes.POST(req(robin.cookie, { method: "POST", body: scene }), p({ slug: s }))],
      ["element image", (s) => m.elementImage.GET(req("", { url: "http://t/x?kind=cutout" }), p({ slug: s, elementId }))],
      ["scene image", (s) => m.sceneImage.GET(req(""), p({ slug: s, sceneId }))],
      ["job GET", (s) => m.job.GET(req(robin.cookie), p({ slug: s, jobId: job.id }))],
      ["tap-add", (s) => m.tap.POST(req(robin.cookie, { method: "POST", body: { x: 0.5, y: 0.5 } }), p({ slug: s, jobId: job.id }))],
      ["confirm", (s) => m.confirm.POST(req(robin.cookie, { method: "POST", body: { jobId: job.id, pinIds: job.pinIds } }), p({ slug: s }))],
      ["transcribe", (s) => m.transcribe.POST(req(robin.cookie, { method: "POST" }), p({ slug: s }))],
      ["skin", (s) => m.skin.PATCH(req(host, { method: "PATCH", body: { skinId: "default" } }), p({ slug: s }))],
      ["delete again", (s) => del(s, host)],
    ];
    for (const [name, call] of calls) {
      const [dead, unknown] = [await call(slug), await call(UNKNOWN)];
      const shape = async (r: Response) => ({ name, status: r.status, body: await r.text(), cookie: r.headers.get("set-cookie") });
      expect(await shape(dead)).toEqual(await shape(unknown));
    }
    // Library: the dead board's thing is no one's — no thumbnail, no copy.
    expect((await myImage(elementId)).status).toBe(404);
    const copy = (id: string) => m.fromLibrary.POST(req(`${robinThere.cookie}; ${alice}`, { method: "POST", body: { elementId: id } }), p({ slug: other.slug }));
    for (const r of [await copy(elementId), await copy("no-such-element")]) {
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual(NOT_FOUND);
    }
    expect(await repo().listElements(other.slug)).toEqual([]);
    expect(await state()).toBe(before);
  });

  it("anyone but the host gets the one 404; cross-site is a 403 before any read; the board stays", async () => {
    const { slug, host } = await newBoard();
    const other = await newBoard();
    const robin = await join(slug, "Robin");
    const token = (cookie: string) => cookie.split("=")[1];
    const misses: [string, string][] = [
      [slug, ""],
      [slug, robin.cookie],
      [slug, `pinned_host_${slug}=h1.${"A".repeat(43)}`],
      [slug, `pinned_host_${slug}=${token(other.host)}`], // another board's host token
      [other.slug, host], // this host's cookie is named for its own board
      [UNKNOWN, `pinned_host_${UNKNOWN}=${token(host)}`],
    ];
    for (const [s, cookie] of misses) {
      const res = await del(s, cookie);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
    const reads = vi.spyOn(repo(), "getBoard");
    expect((await del(slug, host, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    expect(await repo().getBoard(slug)).not.toBeNull();
    expect(await repo().getBoard(other.slug)).not.toBeNull();
  });

  it("two deletes at once: only the call that set the tombstone gets 204, the other the one 404", async () => {
    const { slug, host } = await newBoard();
    const results = await Promise.all([del(slug, host), del(slug, host)]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 404]);
    expect(await results.find((r) => r.status === 404)!.json()).toEqual(NOT_FOUND);
    expect(await repo().getBoard(slug)).toBeNull();
  });

  it("board GET checks the board first: a stale My boards row restores and links nothing", async () => {
    const alice = await signIn("token-alice");
    const { slug, host } = await newBoard();
    const robin = await join(slug, "Robin", alice);
    expect((await del(slug, host)).status).toBe(204);
    // A row the clean-up missed (say a store error), left behind.
    await users().putUserBoard("synthetic-alice", { boardId: slug, participantId: robin.id, claimedAt: 1, updatedAt: 1 });
    const writes = vi.spyOn(repo(), "putParticipant");
    const errors = vi.spyOn(console, "error");
    for (const cookie of [alice, `${robin.cookie}; ${alice}`]) {
      const res = await m.board.GET(req(cookie), p({ slug }));
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(writes).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    writes.mockRestore();
    errors.mockRestore();
  });
});

describe("board delete storage clean-up (PIN-169)", () => {
  it("the folders empty out; a cut-out a library copy uses stays and serves until that copy goes", async () => {
    const alice = await signIn("token-alice");
    const { slug, host } = await newBoard();
    const robin = await join(slug, "Robin", alice);
    const { job } = (await (await upload(slug, robin.cookie)).json()) as { job: { elementIds: string[] } };
    expect(job.elementIds.length).toBeGreaterThan(1);
    await store().put(`scenes/boards/${slug}/${slug}-scene/scene.png`, Buffer.from("png-bytes"), "image/png");
    const other = await newBoard();
    const robinThere = await join(other.slug, "Robin", alice);
    const copied = await m.fromLibrary.POST(
      req(`${robinThere.cookie}; ${alice}`, { method: "POST", body: { elementId: job.elementIds[0] } }),
      p({ slug: other.slug }),
    );
    const copyId = ((await copied.json()) as { elementId: string }).elementId;
    const before = await objectsOf(slug);
    for (const root of ["tmp/", "elements/", "scenes/"]) expect(before.some((ref) => ref.startsWith(root))).toBe(true);
    const otherBefore = await objectsOf(other.slug);

    expect((await del(slug, host)).status).toBe(204);
    const kept = before.filter((ref) => ref.startsWith(`elements/boards/${slug}/${job.elementIds[0]}/`));
    expect(kept).toHaveLength(2);
    expect(await objectsOf(slug)).toEqual(kept);
    expect(await objectsOf(other.slug)).toEqual(otherBefore);
    const image = () => m.elementImage.GET(req("", { url: "http://t/x?kind=cutout" }), p({ slug: other.slug, elementId: copyId }));
    expect((await image()).status).toBe(200);

    // The last live copy goes, and the bytes with it.
    const res = await m.element.DELETE(req(robinThere.cookie, { method: "DELETE" }), p({ slug: other.slug, elementId: copyId }));
    expect(await res.json()).toMatchObject({ deleted: true, storageDeleted: true });
    expect(await objectsOf(slug)).toEqual([]);
    expect((await image()).status).toBe(404);
  });
});
