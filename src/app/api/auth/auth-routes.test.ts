import { describe, expect, it } from "vitest";
import { POST as claimRoute } from "../boards/[slug]/claim/route";
import { GET as meRoute } from "../me/route";
import { GET as myBoardsRoute } from "../me/boards/route";
import { DELETE as deleteSessionRoute, POST as postSessionRoute } from "./session/route";

/**
 * Flag-off route contract (PIN-83 Checks): this file runs with
 * the default env (no AUTH_MODE), so AUTH_MODE=link-only and
 * every sign-in route is the uniform 404 — the new surface does
 * not exist and link-only behaviour is unchanged. Optional-mode
 * behaviour lives in auth-routes.optional.test.ts.
 */
function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

const VALID_SLUG = "AAAAAAAAAAAAAAAAAAAAAQ";

describe("AUTH_MODE=link-only (default): every PIN-83 route 404s", () => {
  it("POST /api/auth/session -> uniform 404", async () => {
    const res = await postSessionRoute(
      req("http://t/api/auth/session", {
        method: "POST",
        body: JSON.stringify({ idToken: "token-alice" }),
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found." });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("DELETE /api/auth/session -> uniform 404", async () => {
    const res = await deleteSessionRoute(
      req("http://t/api/auth/session", { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found." });
  });

  it("GET /api/me/boards -> uniform 404 (PIN-84)", async () => {
    const res = await myBoardsRoute(req("http://t/api/me/boards"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found." });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("GET /api/me -> uniform 404", async () => {
    const res = await meRoute(req("http://t/api/me"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found." });
  });

  it("POST /api/boards/{slug}/claim -> uniform 404 (valid and malformed slugs)", async () => {
    for (const slug of [VALID_SLUG, "a/b", "short"]) {
      const res = await claimRoute(req("http://t/x", { method: "POST" }), {
        params: Promise.resolve({ slug }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found." });
    }
  });
});
