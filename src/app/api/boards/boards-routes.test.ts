import { describe, expect, it } from "vitest";
import { generateSlug, isValidSlug } from "../../../domain/tokens";
import { POST as createBoardRoute } from "./route";
import { GET as getBoardRoute } from "./[slug]/route";
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
