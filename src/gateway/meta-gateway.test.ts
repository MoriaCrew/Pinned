import { describe, expect, it } from "vitest";
import { MetaApiError, MetaGateway, parseModelJson, parseSamOutput } from "./meta-gateway";

function fakeFetch(handler: (url: string, init: RequestInit) => unknown) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const body = handler(String(url), init ?? {});
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const chat = (obj: unknown) => ({
  choices: [{ message: { content: JSON.stringify(obj) } }],
  usage: { prompt_tokens: 10, completion_tokens: 20 },
});

function gateway(fetchFn: typeof fetch, logs: unknown[] = []) {
  return new MetaGateway({
    apiKey: "test-key",
    baseUrl: "https://api.meta.ai/v1",
    sparkModel: "muse-spark-1.3",
    samModel: "sam-3.1",
    imageModel: "muse-image-1.0",
    fetchFn,
    onLog: (e) => {
      logs.push(e);
    },
  });
}

describe("MetaGateway (contract, fake fetch)", () => {
  it("aborts a hung provider call with a timeout error code (PIN-43)", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "TimeoutError";
          reject(err);
        });
      })) as typeof fetch;
    const gw = new MetaGateway({
      apiKey: "test-key",
      baseUrl: "https://api.meta.ai/v1",
      sparkModel: "muse-spark-1.3",
      samModel: "sam-3.1",
      imageModel: "muse-image-1.0",
      fetchFn: hanging,
      timeoutMs: 20,
    });
    await expect(gw.nameObject({ imageRef: "x", maxConceptWords: 3 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("caps chat output tokens (PIN-43)", async () => {
    let seenBody: Record<string, unknown> = {};
    const gw = gateway(fakeFetch((_url, init) => {
      seenBody = JSON.parse(String(init.body));
      return chat({ objectLabel: "mug", altLabel: "a mug", safetyFlags: {} });
    }) as typeof fetch);
    await gw.nameObject({ imageRef: "x", maxConceptWords: 3 });
    expect(seenBody.max_tokens).toBe(4000);
  });
  it("parses a label chat response and logs usage", async () => {
    const logs: unknown[] = [];
    const gw = gateway(
      fakeFetch(() =>
        chat({
          objectLabel: "red mug",
          altLabel: "A red mug",
          safetyFlags: { faces: true },
        }),
      ) as typeof fetch,
      logs,
    );
    const out = await gw.nameObject({ imageRef: "https://x.test/a.jpg", maxConceptWords: 3 });
    expect(out.objectLabel).toBe("red mug");
    expect(out.safetyFlags.faces).toBe(true);
    expect(out.safetyFlags.screens).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ operation: "nameObject", outcome: "ok", inputTokens: 10 });
  });

  it("sends Bearer auth and the pinned model to /chat/completions", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenModel = "";
    const gw = gateway(fakeFetch((url, init) => {
      seenUrl = url;
      seenAuth = String((init.headers as Record<string, string>).authorization);
      seenModel = JSON.parse(String(init.body)).model;
      return chat({ objectLabel: "mug", altLabel: "a mug", safetyFlags: {} });
    }) as typeof fetch);
    await gw.nameObject({ imageRef: "x", maxConceptWords: 3 });
    expect(seenUrl).toBe("https://api.meta.ai/v1/chat/completions");
    expect(seenAuth).toBe("Bearer test-key");
    expect(seenModel).toBe("muse-spark-1.3");
  });

  it("surfaces API errors with status and code, never the key", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "Unauthorized" } }), {
        status: 401,
      });
    const gw = gateway(fetchFn as typeof fetch);
    const err = await gw.nameObject({ imageRef: "x", maxConceptWords: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_api_key");
    expect(String(err.message)).not.toContain("test-key");
  });

  it("parses SAM special-token records (docs grammar)", async () => {
    const line =
      "<0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,101,~abc!|>,1<|box;x1=260;y1=382;x2=340;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,81,~def|>";
    const segs = parseSamOutput(line);
    expect(segs).toHaveLength(2);
    expect(segs[0].box).toEqual({ x1: 353, y1: 382, x2: 453, y2: 427, w: 537, h: 561 });
    expect(segs[0].mask).toEqual({ height: 46, width: 101, encoding: "~", payload: "abc!" });
    expect(parseSamOutput("")).toEqual([]);
    const gw = gateway(fakeFetch(() => ({ output: [{ content: [{ type: "output_text", text: line }] }] })) as typeof fetch);
    const out = await gw.segmentObject({ imageRef: "https://x/a.jpg", concept: "button" });
    expect(out.segments).toHaveLength(2);
  });

  it("SAM empty output_text is a valid no-match, not an error", async () => {
    const gw = gateway(fakeFetch(() => ({ output: [{ content: [{ type: "output_text", text: "" }] }] })) as typeof fetch);
    await expect(gw.segmentObject({ imageRef: "https://x/a.jpg", concept: "mug" })).resolves.toEqual({
      segments: [],
    });
    const gwTop = gateway(fakeFetch(() => ({ output_text: "" })) as typeof fetch);
    await expect(gwTop.segmentObject({ imageRef: "https://x/a.jpg", concept: "mug" })).resolves.toEqual({
      segments: [],
    });
  });

  it("SAM unknown shape throws sam_shape_unknown with keys", async () => {
    const gw = gateway(fakeFetch(() => ({ id: "r1", output: [{ type: "text", text: "?" }] })) as typeof fetch);
    const err = await gw.segmentObject({ imageRef: "https://x/a.jpg", concept: "mug" }).catch((e) => e);
    expect(err.code).toBe("sam_shape_unknown");
  });

  it("strips code fences when parsing model JSON", () => {
    expect(parseModelJson("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(() => parseModelJson("not json")).toThrow(MetaApiError);
  });
});
