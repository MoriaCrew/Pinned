import { beforeEach, describe, expect, it, vi } from "vitest";

// PIN-196: errors carry catalog keys; errorResponse answers in the
// request's language. fr.json is stubbed (never edited by hand), so
// one key is "translated" and every other key falls back to English.
const locale = vi.hoisted(() => ({
  enabled: ["en", "fr"] as string[],
  current: vi.fn(async (): Promise<string> => "fr"),
}));

vi.mock("../../../i18n/messages/fr.json", () => ({
  default: { "error.boardFull": "Ce tableau est complet." },
}));
vi.mock("../../../i18n/server", () => ({ getLocale: locale.current }));
vi.mock("../../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config")>();
  return {
    ...actual,
    getConfig: () => ({ ...actual.getConfig(), uiLocales: locale.enabled }),
  };
});

const { errorResponse } = await import("./shared");
const { plusErrorResponse } = await import("./plus-shared");
const { BoardApiError } = await import("../../../server/board-session");
const { BoardPlusError } = await import("../../../server/board-plus");
const { userMessage } = await import("../../../i18n/user-message");
const { PhotoIntakeError } = await import("../../../server/photo-intake");

describe("errorResponse in the request's language (PIN-196)", () => {
  beforeEach(() => {
    locale.enabled = ["en", "fr"];
    locale.current.mockReset();
    locale.current.mockResolvedValue("fr");
  });

  it("answers a French request in French when the key is translated", async () => {
    const response = errorResponse(new BoardApiError(userMessage("error.boardFull"), 409), "x");
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Ce tableau est complet." });
  });

  it("falls back to English for a key French has not translated yet", async () => {
    const response = errorResponse(
      new BoardApiError(userMessage("error.titleTooLong", { max: 80 })),
      "x",
    );
    expect(await response.json()).toEqual({ error: "Give your board a title up to 80 characters." });
  });

  it("answers an English request in English", async () => {
    locale.current.mockResolvedValue("en");
    const response = errorResponse(new BoardApiError(userMessage("error.boardFull"), 409), "x");
    expect(await response.json()).toEqual({ error: "This board is full." });
  });

  it("with English only, builds the same body as before without reading the request", async () => {
    locale.enabled = ["en"];
    const response = errorResponse(new BoardApiError(userMessage("error.boardFull"), 409), "x");
    expect(await response.json()).toEqual({ error: "This board is full." });
    expect(locale.current).not.toHaveBeenCalled();
  });

  it("keeps English when the language lookup fails, never a 500", async () => {
    locale.current.mockRejectedValue(new Error("no request scope"));
    const response = errorResponse(new BoardApiError(userMessage("error.boardFull"), 409), "x");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This board is full." });
  });

  it("keeps the uniform 404 and the generic 500", async () => {
    const missing = errorResponse(new BoardApiError("Board not found.", 404), "x");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found." });
    const unknown = errorResponse(new Error("boom"), "Could not load this board.");
    expect(unknown.status).toBe(500);
    expect(await unknown.json()).toEqual({ error: "Could not load this board." });
  });

  it("translates Board Plus errors and keeps their code", async () => {
    const error = new BoardPlusError(userMessage("error.boardFull"), 403, "host_only");
    const response = plusErrorResponse(error, "x");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Ce tableau est complet.", code: "host_only" });
  });
});

describe("errorResponse code passthrough", () => {
  it("emits BoardApiError.code so clients can classify 429s (pool-empty never fired client-side before)", async () => {
    const res = errorResponse(
      new BoardApiError("This board is out of makes.", 429, "credits_pool_empty"),
      "fallback",
    );
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      error: "This board is out of makes.",
      code: "credits_pool_empty",
    });
  });

  it("omits code when the error carries none (code-less stays code-less)", async () => {
    const res = errorResponse(new BoardApiError("Bad input.", 400), "fallback");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Bad input." });
  });

  it("emits PhotoIntakeError.code", async () => {
    const res = errorResponse(new PhotoIntakeError("Too big.", "too_large", 413), "fallback");
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "Too big.", code: "too_large" });
  });

  it("404 stays the uniform body with no code (no existence leak)", async () => {
    const res = errorResponse(new BoardApiError("Job not found.", 404, "job"), "fallback");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found." });
  });
});
