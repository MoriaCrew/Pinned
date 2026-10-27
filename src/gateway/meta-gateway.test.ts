import { describe, expect, it } from "vitest";
import { MetaApiError, MetaGateway, findImageRef, imageFormatFromBase64, parseModelJson, parseSamOutput } from "./meta-gateway";

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
    onLog: (e) => logs.push(e),
  });
}

describe("MetaGateway (contract, fake fetch)", () => {
  it("parses a persona chat response and logs usage", async () => {
    const logs: unknown[] = [];
    const gw = gateway(
      fakeFetch(() =>
        chat({
          persona: { name: "Nana", language: "en", voiceRules: ["dry"], catchphrases: [], judgingStyle: "s" },
          challenge: "Find a mug.",
        }),
      ) as typeof fetch,
      logs,
    );
    const out = await gw.generatePersona("my unimpressed grandmother");
    expect(out.persona.name).toBe("Nana");
    expect(out.challenge).toBe("Find a mug.");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ operation: "generatePersona", outcome: "ok", inputTokens: 10 });
  });

  it("sends Bearer auth and the pinned model to /chat/completions", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenModel = "";
    const gw = gateway(fakeFetch((url, init) => {
      seenUrl = url;
      seenAuth = String((init.headers as Record<string, string>).authorization);
      seenModel = JSON.parse(String(init.body)).model;
      return chat({ persona: {}, challenge: "c" });
    }) as typeof fetch);
    await gw.generatePersona("x");
    expect(seenUrl).toBe("https://api.meta.ai/v1/chat/completions");
    expect(seenAuth).toBe("Bearer test-key");
    expect(seenModel).toBe("muse-spark-1.3");
  });

  it("judges a photo and validates rubric ranges", async () => {
    const gw = gateway(fakeFetch(() =>
      chat({
        objectLabel: "red stapler",
        altLabel: "A desk item",
        scores: { fit: 4, effort: 3, chaos: 5 },
        reason: "r",
        privateJudgement: "j",
        teaser: "t",
        safetyFlags: { screens: true },
      }),
    ) as typeof fetch);
    const out = await gw.judgePhoto({ imageRef: "https://x.test/a.jpg", challenge: "c" });
    expect(out.scores).toEqual({ fit: 4, effort: 3, chaos: 5 });
    expect(out.safetyFlags.screens).toBe(true);
    expect(out.safetyFlags.faces).toBe(false);
  });

  it("rejects out-of-range model scores", async () => {
    const gw = gateway(fakeFetch(() => chat({ scores: { fit: 9, effort: 0, chaos: 0 } })) as typeof fetch);
    await expect(gw.judgePhoto({ imageRef: "https://x/a.jpg", challenge: "c" })).rejects.toThrow(RangeError);
  });

  it("surfaces API errors with status and code, never the key", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "Unauthorized" } }), {
        status: 401,
      });
    const gw = gateway(fetchFn as typeof fetch);
    const err = await gw.generatePersona("x").catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_api_key");
    expect(String(err.message)).not.toContain("test-key");
  });

  it("extracts image URLs and base64 from nested shapes", () => {
    expect(findImageRef({ data: [{ url: "https://cdn.test/x?sig=1" }] })).toBe("https://cdn.test/x?sig=1");
    expect(findImageRef({ output: [{ b64_json: "AAA" }] })).toBe("data:image/png;base64,AAA");
    expect(findImageRef({ data: [{ b64_json: "UklGRabc" }] })).toBe("data:image/webp;base64,UklGRabc");
    expect(imageFormatFromBase64("iVBORw0KGgoAAA", "webp")).toBe("png");
    expect(imageFormatFromBase64("unknown", "jpg")).toBe("jpeg");
    expect(findImageRef({ nothing: true })).toBeNull();
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
