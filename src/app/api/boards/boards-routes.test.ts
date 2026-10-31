import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { emptyBoardCounters } from "../../../domain/board";
import { generateSlug, isValidSlug } from "../../../domain/tokens";
import { DEFAULT_POLICY } from "../../../policy/policy";
import { getBoardRepository } from "../../../server/board-repository";
import { getDerivativeStore } from "../../../server/derivative-store";
import { POST as createBoardRoute } from "./route";
import { DELETE as deleteBoardRoute, GET as getBoardRoute } from "./[slug]/route";
import {
  GET as getMeRoute,
  POST as joinRoute,
} from "./[slug]/participants/route";
import { POST as uploadRoute } from "./[slug]/photos/route";
import { GET as getJobRoute } from "./[slug]/jobs/[jobId]/route";
import { POST as confirmRoute } from "./[slug]/pins/confirm/route";
import { GET as imageRoute } from "./[slug]/elements/[elementId]/image/route";
import { DELETE as deleteElementRoute } from "./[slug]/elements/[elementId]/route";
import { GET as getScenesRoute, POST as postSceneRoute } from "./[slug]/scenes/route";
import { DELETE as deleteSceneRoute, GET as getSceneRoute } from "./[slug]/scenes/[sceneId]/route";
import { GET as sceneImageRoute } from "./[slug]/scenes/[sceneId]/image/route";

/**
 * Route-guard tests (PIN-65 Checks): isValidSlug runs FIRST in
 * every [slug] handler — a malformed slug (including %2F-decoded
 * paths) is a 404 before any repository read, and every kind of
 * miss renders the identical 404 body (no existence leak).
 * Full behaviour lives in src/server/board-api.test.ts; these run
 * against the memory backends (no env, AI_MOCK defaults on).
 */
const BAD_SLUGS = ["a/b", "short", "x".repeat(23), "..%2f..", "", "has space has space1"];

function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

function slugParams(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

async function bodyOf(res: Response): Promise<unknown> {
  return res.json();
}

describe("slug gate: malformed slug -> uniform 404 on every board route", () => {
  it.each(BAD_SLUGS)("GET board with slug %j", async (slug) => {
    const res = await getBoardRoute(req("http://t/api/boards/x"), slugParams(slug));
    expect(res.status).toBe(404);
    expect(await bodyOf(res)).toEqual({ error: "Not found." });
  });

  it("applies to participants, photos, jobs, confirm and image routes", async () => {
    const slug = "a/b";
    const calls: Promise<Response>[] = [
      getMeRoute(req("http://t/x"), slugParams(slug)),
      joinRoute(
        req("http://t/x", { method: "POST", body: JSON.stringify({ displayName: "R" }) }),
        slugParams(slug),
      ),
      uploadRoute(req("http://t/x", { method: "POST" }), slugParams(slug)),
      getJobRoute(req("http://t/x"), {
        params: Promise.resolve({ slug, jobId: "job-1" }),
      }),
      confirmRoute(
        req("http://t/x", {
          method: "POST",
          body: JSON.stringify({ jobId: "job-1", pinIds: ["p"] }),
        }),
        slugParams(slug),
      ),
      getScenesRoute(req("http://t/x"), slugParams(slug)),
      postSceneRoute(
        req("http://t/x", { method: "POST", body: JSON.stringify({ elementIds: ["el-1"], prompt: "x" }) }),
        slugParams(slug),
      ),
      getSceneRoute(req("http://t/x"), {
        params: Promise.resolve({ slug, sceneId: "scene-1" }),
      }),
      sceneImageRoute(req("http://t/x"), {
        params: Promise.resolve({ slug, sceneId: "scene-1" }),
      }),
      imageRoute(req("http://t/x?kind=cutout"), {
        params: Promise.resolve({ slug, elementId: "el-1" }),
      }),
    ];
    calls.push(
      deleteBoardRoute(req("http://t/x", { method: "DELETE" }), slugParams(slug)),
      deleteElementRoute(req("http://t/x", { method: "DELETE" }), {
        params: Promise.resolve({ slug, elementId: "el-1" }),
      }),
      deleteSceneRoute(req("http://t/x", { method: "DELETE" }), {
        params: Promise.resolve({ slug, sceneId: "scene-1" }),
      }),
    );
    for (const call of calls) {
      const res = await call;
      expect(res.status).toBe(404);
      expect(await bodyOf(res)).toEqual({ error: "Not found." });
    }
  });
});

describe("board delete in link-only mode (PIN-167)", () => {
  it("the host's DELETE is a 204, then the board is the uniform 404", async () => {
    const created = await createBoardRoute(
      req("http://t/api/boards", { method: "POST", body: JSON.stringify({ title: "Gone board" }) }),
    );
    const { board } = (await created.json()) as { board: { slug: string } };
    const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0];
    const del = await deleteBoardRoute(req("http://t/x", { method: "DELETE", headers: { cookie } }), slugParams(board.slug));
    expect(del.status).toBe(204);
    const res = await getBoardRoute(req("http://t/x"), slugParams(board.slug));
    expect(res.status).toBe(404);
    expect(await bodyOf(res)).toEqual({ error: "Not found." });
  });
});

describe("uniform 404: unknown board / element / job are indistinguishable", () => {
  it("returns the identical status and body for every kind of miss", async () => {
    const unknownSlug = generateSlug();
    expect(isValidSlug(unknownSlug)).toBe(true);

    const created = await createBoardRoute(
      req("http://t/api/boards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Route test board" }),
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await bodyOf(created)) as { board: { slug: string } };
    const realSlug = createdBody.board.slug;
    expect(isValidSlug(realSlug)).toBe(true);

    const okRes = await getBoardRoute(req("http://t/x"), slugParams(realSlug));
    expect(okRes.status).toBe(200);

    const misses: Promise<Response>[] = [
      deleteElementRoute(req("http://t/x", { method: "DELETE" }), {
        params: Promise.resolve({ slug: realSlug, elementId: "missing" }),
      }),
      deleteElementRoute(req("http://t/x", { method: "DELETE" }), {
        params: Promise.resolve({ slug: unknownSlug, elementId: "missing" }),
      }),
      getBoardRoute(req("http://t/x"), slugParams(unknownSlug)),
      getScenesRoute(req("http://t/x"), slugParams(unknownSlug)),
      getSceneRoute(req("http://t/x"), {
        params: Promise.resolve({ slug: realSlug, sceneId: "missing" }),
      }),
      sceneImageRoute(req("http://t/x"), {
        params: Promise.resolve({ slug: unknownSlug, sceneId: "missing" }),
      }),
      imageRoute(req("http://t/x?kind=cutout"), {
        params: Promise.resolve({ slug: realSlug, elementId: "missing" }),
      }),
      imageRoute(req("http://t/x?kind=cutout"), {
        params: Promise.resolve({ slug: unknownSlug, elementId: "missing" }),
      }),
      imageRoute(req("http://t/x?kind=working"), {
        params: Promise.resolve({ slug: realSlug, elementId: "missing" }),
      }),
      getJobRoute(req("http://t/x"), {
        params: Promise.resolve({ slug: realSlug, jobId: "missing" }),
      }),
      getJobRoute(req("http://t/x"), {
        params: Promise.resolve({ slug: unknownSlug, jobId: "missing" }),
      }),
    ];
    for (const miss of misses) {
      const res = await miss;
      expect(res.status).toBe(404);
      expect(await bodyOf(res)).toEqual({ error: "Not found." });
    }
  });
});

describe("scene image ?size=preview (PIN-133)", () => {
  it("serves the WebP preview with the full's cache header; the full is unchanged; misses are the same 404", async () => {
    const slug = generateSlug();
    const boards = getBoardRepository();
    await boards.createBoard({ slug, title: "Preview route", counters: emptyBoardCounters(), createdAt: 1, version: 1 });
    const imageRef = `scenes/boards/${slug}/s1/scene.png`;
    const full = await sharp({ create: { width: 1280, height: 1920, channels: 3, background: "#c8785a" } }).png().toBuffer();
    await getDerivativeStore().put(imageRef, full, "image/png");
    await boards.putScene({ id: "s1", boardId: slug, createdBy: "p1", elementIds: [], prompt: "x", status: "ready", imageRef, promptVersion: "scene.v1", createdAt: 1 });
    const get = (s: string, sceneId: string, query = "") =>
      sceneImageRoute(req(`http://t/x${query}`), { params: Promise.resolve({ slug: s, sceneId }) });

    const preview = await get(slug, "s1", "?size=preview");
    const whole = await get(slug, "s1");
    expect(preview.headers.get("content-type")).toBe("image/webp");
    expect(preview.headers.get("cache-control")).toBe(whole.headers.get("cache-control"));
    expect(preview.headers.get("cache-control")).toMatch(/^private, max-age=\d+$/);
    const meta = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 683, 1024]);
    expect(whole.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await whole.arrayBuffer()).equals(full)).toBe(true);
    for (const miss of [await get(generateSlug(), "s1", "?size=preview"), await get(slug, "missing", "?size=preview")]) {
      expect(miss.status).toBe(404);
      expect(await bodyOf(miss)).toEqual({ error: "Not found." });
    }
  });
});

describe("cut-out image cache header (PIN-217)", () => {
  it("a board-link hit is privately cacheable for Policy.elementImageCacheSeconds, a board override wins, misses stay no-store", async () => {
    const boards = getBoardRepository();
    const store = getDerivativeStore();
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#c8785a" } }).png().toBuffer();
    const seedBoard = async (policyOverrides?: { elementImageCacheSeconds: number }) => {
      const slug = generateSlug();
      await boards.createBoard({ slug, title: "Cut-out cache", counters: emptyBoardCounters(), createdAt: 1, version: 1, ...(policyOverrides ? { policyOverrides } : {}) });
      const cutoutRef = `elements/${slug}/el-1/cutout.png`;
      const flattenedRef = `elements/${slug}/el-1/flat.jpg`;
      await store.put(cutoutRef, bytes, "image/png");
      await store.put(flattenedRef, bytes, "image/jpeg");
      await boards.createElement({
        id: `${slug}-el-1`, boardId: slug, ownerId: "p1", label: "teal mug", description: "a teal mug",
        maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 }, cutoutRef, flattenedRef, sourcePhotoId: "photo-1", faceFlag: false, createdAt: 1,
      });
      return { slug, elementId: `${slug}-el-1` };
    };
    const get = (slug: string, elementId: string, kind: string) =>
      imageRoute(req(`http://t/x?kind=${kind}`), { params: Promise.resolve({ slug, elementId }) });

    const { slug, elementId } = await seedBoard();
    for (const kind of ["cutout", "flattened"]) {
      const res = await get(slug, elementId, kind);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(`private, max-age=${DEFAULT_POLICY.elementImageCacheSeconds}`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    // The board-link check still gates every request that reaches the server.
    for (const miss of [await get(generateSlug(), elementId, "cutout"), await get(slug, "missing", "cutout"), await get(slug, elementId, "working")]) {
      expect(miss.status).toBe(404);
      expect(miss.headers.get("cache-control")).toBe("no-store");
    }
    // A board's own override wins over the default.
    const tuned = await seedBoard({ elementImageCacheSeconds: 60 });
    expect((await get(tuned.slug, tuned.elementId, "cutout")).headers.get("cache-control")).toBe("private, max-age=60");
  });
});

describe("POST /api/boards with credits off (PIN-205)", () => {
  it("stores no starterMakes and writes no maker counter: creation unchanged", async () => {
    const res = await createBoardRoute(
      req("http://t/api/boards", {
        method: "POST",
        headers: { "x-forwarded-for": "192.0.2.30" },
        body: JSON.stringify({ title: "Credits off" }),
      }),
    );
    expect(res.status).toBe(201);
    const { board } = (await bodyOf(res)) as { board: { slug: string } };
    expect(board).not.toHaveProperty("starterMakes");
    expect(await getBoardRepository().getBoard(board.slug)).not.toHaveProperty("starterMakes");
  });
});
