import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, resolvePolicy } from "../policy/policy";
import {
  fixtureChipSuggester,
  fixtureElementNamer,
  fixtureSegmenter,
  type StudioFixtures,
} from "./fixture-ports";
import { MetaGateway } from "./meta-gateway";
import { metaChipSuggester, metaElementNamer, metaSegmenter } from "./meta-ports";
import { mockChipSuggester, mockElementNamer, mockSegmenter } from "./mock-ports";
import {
  buildSegmentPromptText,
  classifyPortError,
  elementsSystemPrompt,
  chipsSystemPrompt,
  generatedImageCount,
  normalizeChips,
  normalizeElements,
  normalizeTapName,
  sceneElementLabel,
  type SegmentPrompt,
  type SuggestChipsInput,
  sceneImageOutcome,
  type NameElementsInput,
} from "./ports";

const fixtures = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "eval/fixtures/studio/fixtures.json"),
    "utf8",
  ),
) as StudioFixtures;

function namerInput(over: Partial<NameElementsInput> = {}): NameElementsInput {
  const p = DEFAULT_POLICY;
  return {
    imageRef: "https://x.test/photo.jpg",
    minElements: p.elementsPerPhoto.min,
    maxElements: p.elementsPerPhoto.max,
    conceptMaxWords: p.conceptMaxWords,
    labelMaxChars: p.elementLabelMaxChars,
    maxTokens: p.maxTokens.sparkElements,
    timeoutMs: p.timeoutsMs.spark,
    promptVersion: p.promptVersions.elements,
    ...over,
  };
}

const SAM_LINE =
  "<0f>0<|box;x1=10;y1=20;x2=110;y2=120;w=200;h=200|><|mask;x=0;y=0;data=101,101,~abc|>";

function metaGateway(handler: (url: string, body: Record<string, unknown>) => unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify(handler(String(url), body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    gateway: new MetaGateway({
      apiKey: "test-key",
      baseUrl: "https://api.meta.ai/v1",
      sparkModel: DEFAULT_POLICY.models.spark,
      samModel: DEFAULT_POLICY.models.sam,
      imageModel: DEFAULT_POLICY.models.image,
      fetchFn,
    }),
  };
}

describe("normalizeElements", () => {
  const LABEL_CAP = DEFAULT_POLICY.elementLabelMaxChars;

  it("caps count, truncates concepts to the Policy word cap, dedupes", () => {
    const out = normalizeElements(
      [
        { label: "A", concept: "Big Red Alarm Clock Extra", description: "d", faceFlag: true },
        { label: "B", concept: "big red alarm", description: "dup" },
        { label: "C", concept: "", description: "drop" },
        { label: "D", concept: "teal mug", description: "d" },
      ],
      { maxElements: 2, conceptMaxWords: 3, labelMaxChars: LABEL_CAP },
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ concept: "big red alarm", faceFlag: true });
    expect(out[1].concept).toBe("teal mug");
  });

  it("falls back to concept for empty label/description and caps at zero", () => {
    const out = normalizeElements([{ label: "", concept: "teal mug", description: "" }], { maxElements: 6, conceptMaxWords: 3, labelMaxChars: LABEL_CAP });
    expect(out[0]).toMatchObject({ label: "teal mug", description: "teal mug" });
    expect(normalizeElements([{ concept: "teal mug" }], { maxElements: 0, conceptMaxWords: 3, labelMaxChars: LABEL_CAP })).toEqual([]);
  });

  it("cuts labels at a lowered Policy elementLabelMaxChars in all three normalizers, by code point (PIN-155)", () => {
    const labelMaxChars = resolvePolicy(null, { elementLabelMaxChars: 5 }).elementLabelMaxChars;
    const astral = "\u{1D49C}"; // one code point, two UTF-16 units
    const [mug, letters] = normalizeElements(
      [{ label: "Rustic Teal Mug", concept: "teal mug" }, { label: astral.repeat(6), concept: "letters" }],
      { maxElements: 6, conceptMaxWords: 3, labelMaxChars },
    );
    expect(mug.label).toBe("Rusti");
    expect(letters.label).toBe(astral.repeat(5));
    expect(normalizeTapName({ label: "Rustic Teal Mug" }, { conceptMaxWords: 3, labelMaxChars })?.label).toBe("Rusti");
    expect(sceneElementLabel({ label: "Rustic  Teal Mug", description: "", imageRef: "x" }, 0, labelMaxChars)).toBe(
      "Element 1: Rusti",
    );
  });

  it("substitutes Policy numbers into the elements prompt", () => {
    const text = elementsSystemPrompt({ minElements: 1, maxElements: 6, conceptMaxWords: 3 });
    expect(text).toContain("Between 1 and 6 elements");
    expect(text).toContain("at most 3");
    expect(text).not.toContain("{{");
  });
});

describe("mock adapters", () => {
  it("name elements with no user-visible mock marker", async () => {
    const out = await mockElementNamer.nameElements(namerInput());
    expect(out.status).toBe("ready");
    if (out.status !== "ready") return;
    expect(out.value.elements.length).toBeGreaterThan(0);
    expect(JSON.stringify(out.value)).not.toContain("(mock)");
    expect(out.value.promptVersion).toBe(DEFAULT_POLICY.promptVersions.elements);
  });

  it("segment returns a mask-shaped segment", async () => {
    const out = await mockSegmenter.segment({
      imageRef: "x",
      prompt: { kind: "concept", concept: "teal mug" },
      timeoutMs: DEFAULT_POLICY.timeoutsMs.sam,
    });
    expect(out.status).toBe("ready");
    if (out.status === "ready") expect(out.value.segments[0].mask.height).toBeGreaterThan(0);
  });
});

describe("fixture adapters (recorded PIN-50 fixtures)", () => {
  it("replay the recorded elements for a photo", async () => {
    const namer = fixtureElementNamer(fixtures);
    const out = await namer.nameElements(namerInput({ fixturePhotoId: "desk-mug-duck" }));
    expect(out.status).toBe("ready");
    if (out.status !== "ready") return;
    expect(out.value.elements.map((e) => e.concept)).toEqual([
      "teal mug",
      "rubber duck",
      "potted succulent",
    ]);
    expect(out.value.elements.every((e) => e.faceFlag === false)).toBe(true);
  });

  it("preserve the recorded faceFlag for person photos", async () => {
    const namer = fixtureElementNamer(fixtures);
    const out = await namer.nameElements(namerInput({ fixturePhotoId: "person-herb-kitchen" }));
    expect(out.status).toBe("ready");
    if (out.status === "ready") {
      expect(out.value.elements.some((e) => e.faceFlag)).toBe(true);
    }
  });

  it("fail (not throw) for an unknown fixture photo", async () => {
    const namer = fixtureElementNamer(fixtures);
    const out = await namer.nameElements(namerInput({ fixturePhotoId: "nope" }));
    expect(out).toMatchObject({ status: "failed", errorCode: "fixture_not_found" });
  });

  it("replay the recorded SAM box for a concept", async () => {
    const segmenter = fixtureSegmenter(fixtures);
    const out = await segmenter.segment({
      imageRef: "x",
      prompt: { kind: "concept", concept: "teal mug" },
      timeoutMs: DEFAULT_POLICY.timeoutsMs.sam,
    });
    expect(out.status).toBe("ready");
    if (out.status !== "ready") return;
    expect(out.value.segments.length).toBeGreaterThan(0);
    expect(out.value.segments[0].box).toMatchObject({ x1: 527, y1: 429, x2: 742, y2: 618 });
  });
});

describe("meta adapters (fake fetch)", () => {
  it("nameElements parses Spark JSON and sends the Policy token budget", async () => {
    const { calls, gateway } = metaGateway(() => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              elements: [
                { label: "Teal Mug", concept: "Teal Mug", description: "worn glaze", faceFlag: false },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    }));
    const out = await metaElementNamer(gateway).nameElements(namerInput());
    expect(out.status).toBe("ready");
    if (out.status === "ready") expect(out.value.elements[0].concept).toBe("teal mug");
    expect(calls[0].url).toBe("https://api.meta.ai/v1/chat/completions");
    expect(calls[0].body.max_tokens).toBe(DEFAULT_POLICY.maxTokens.sparkElements);
    expect(DEFAULT_POLICY.maxTokens.sparkElements).toBe(4000);
  });

  it("maps a provider content-policy error to refused", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ error: { code: "content_policy", message: "refused by content policy" } }),
        { status: 400 },
      )) as typeof fetch;
    const gateway = new MetaGateway({
      apiKey: "test-key",
      baseUrl: "https://api.meta.ai/v1",
      sparkModel: "m",
      samModel: "s",
      imageModel: "i",
      fetchFn,
    });
    const out = await metaElementNamer(gateway).nameElements(namerInput());
    expect(out).toMatchObject({ status: "refused", errorCode: "content_policy" });
  });

  it("segment sends concept, point and box prompts over /responses", async () => {
    const { calls, gateway } = metaGateway(() => ({ output_text: SAM_LINE }));
    const segmenter = metaSegmenter(gateway);
    const base = { imageRef: "https://x.test/a.jpg", timeoutMs: DEFAULT_POLICY.timeoutsMs.sam };

    const concept = await segmenter.segment({ ...base, prompt: { kind: "concept", concept: "teal mug" } });
    expect(concept.status).toBe("ready");
    if (concept.status === "ready") expect(concept.value.segments).toHaveLength(1);

    const point = await segmenter.segment({
      ...base,
      prompt: { kind: "point", points: [{ x: 0.5, y: 0.25 }], frame: { width: 100, height: 200 } },
    });
    expect(point.status).toBe("ready");

    const box = await segmenter.segment({
      ...base,
      prompt: { kind: "box", box: { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.8 }, frame: { width: 100, height: 200 } },
    });
    expect(box.status).toBe("ready");

    const texts = calls.map((c) => {
      const input = c.body.input as { content: { type: string; text?: string }[] }[];
      return input[0].content.find((part) => part.type === "input_text")?.text ?? "";
    });
    expect(calls.every((c) => c.url === "https://api.meta.ai/v1/responses")).toBe(true);
    expect(texts[0]).toBe("teal mug");
    // Point/box go through buildObjectPrompt: wire tokens, not prose.
    expect(texts[1]).not.toBe(texts[0]);
    expect(texts[1].length).toBeGreaterThan(0);
    expect(texts[2].length).toBeGreaterThan(0);
    expect(texts[1]).not.toBe(texts[2]);
  });

  it("segment omits `store` by default and sends store:false for concept and point calls (PIN-213)", async () => {
    const { calls, gateway } = metaGateway(() => ({ output_text: SAM_LINE }));
    const segmenter = metaSegmenter(gateway);
    const base = { imageRef: "https://x.test/a.jpg", timeoutMs: DEFAULT_POLICY.timeoutsMs.sam };
    const concept: SegmentPrompt = { kind: "concept", concept: "teal mug" };
    const point: SegmentPrompt = {
      kind: "point",
      points: [{ x: 0.5, y: 0.25 }],
      frame: { width: 100, height: 200 },
    };

    await segmenter.segment({ ...base, prompt: concept });
    await segmenter.segment({ ...base, prompt: point });
    expect(calls.map((c) => "store" in c.body)).toEqual([false, false]);

    await segmenter.segment({ ...base, prompt: concept, store: false });
    await segmenter.segment({ ...base, prompt: point, store: false });
    expect(calls.slice(2).map((c) => c.body.store)).toEqual([false, false]);
    // Same SAM model, endpoint and prompt text as the default calls.
    expect(calls[2].body.model).toBe(calls[0].body.model);
    expect(calls[3].body.input).toEqual(calls[1].body.input);
  });

  it("mock and fixture segmenters ignore `store` (PIN-213)", async () => {
    const base = { imageRef: "https://x.test/a.jpg", timeoutMs: DEFAULT_POLICY.timeoutsMs.sam };
    const prompt: SegmentPrompt = { kind: "concept", concept: "teal mug" };
    const mockPlain = await mockSegmenter.segment({ ...base, prompt });
    const mockStore = await mockSegmenter.segment({ ...base, prompt, store: false });
    expect(mockStore).toEqual(mockPlain);

    const fixture = fixtureSegmenter(fixtures);
    const fixturePlain = await fixture.segment({ ...base, prompt });
    const fixtureStore = await fixture.segment({ ...base, prompt, store: false });
    expect(fixtureStore).toEqual(fixturePlain);
    expect(mockPlain.status).toBe("ready");
    expect(fixturePlain.status).toBe("ready");
  });

  it("passes the provider HTTP status through for retry decisions (PIN-61)", () => {
    const rateLimited = Object.assign(new Error("slow down"), {
      code: "http_429",
      status: 429,
    });
    expect(classifyPortError(rateLimited)).toMatchObject({
      status: "failed",
      errorCode: "http_429",
      httpStatus: 429,
    });
    const refused = Object.assign(new Error("nope"), {
      code: "content_policy_violation",
      status: 400,
    });
    expect(classifyPortError(refused)).toMatchObject({
      status: "refused",
      httpStatus: 400,
    });
  });

  it("rejects invalid geometry as failed/bad_prompt without calling SAM", async () => {
    const { calls, gateway } = metaGateway(() => ({ output_text: SAM_LINE }));
    const out = await metaSegmenter(gateway).segment({
      imageRef: "x",
      prompt: { kind: "box", box: { x1: 0.9, y1: 0.1, x2: 0.2, y2: 0.8 }, frame: { width: 10, height: 10 } },
      timeoutMs: 1000,
    });
    expect(out).toMatchObject({ status: "failed", errorCode: "bad_prompt" });
    expect(calls).toHaveLength(0);
    expect(buildSegmentPromptText({ kind: "concept", concept: "  " }).status).toBe("failed");
  });
});

describe("ChipSuggester port (PIN-75)", () => {
  function chipsInput(over: Partial<SuggestChipsInput> = {}): SuggestChipsInput {
    const p = DEFAULT_POLICY;
    return {
      labels: ["Teal Mug", "Orange Tabby Cat"],
      maxChips: p.chipsMax,
      maxChipChars: p.scenePromptMaxChars,
      maxTokens: p.maxTokens.sparkChips,
      timeoutMs: p.timeoutsMs.spark,
      promptVersion: p.promptVersions.chips,
      ...over,
    };
  }

  it("system prompt is prompts/chips.v1.md above the rule, Policy count in the slot", () => {
    const file = readFileSync(
      path.join(process.cwd(), "prompts/chips.v1.md"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const aboveRule = file.split("\n---\n")[0].trimEnd();
    expect(chipsSystemPrompt({ maxChips: 4 })).toBe(
      aboveRule.replaceAll("{{MAX_CHIPS}}", "4"),
    );
  });

  it("normalizeChips dedupes, caps count/chars and drops junk", () => {
    expect(
      normalizeChips(
        [" in space. ", "In Space", 42, "", "at the beach!", "x".repeat(600), "in a treehouse"],
        { maxChips: 3, maxChipChars: 500 },
      ),
    ).toEqual(["in space", "at the beach", "in a treehouse"]);
    expect(normalizeChips("nope", { maxChips: 4, maxChipChars: 500 })).toEqual([]);
  });

  it("meta suggester sends labels as JSON data with the chips token budget", async () => {
    const { calls, gateway } = metaGateway(() => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              chips: ["sharing a tiny espresso bar", "Sharing A Tiny Espresso Bar", "napping in a sunbeam"],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 30 },
    }));
    const out = await metaChipSuggester(gateway).suggestChips(chipsInput());
    expect(out).toEqual({
      status: "ready",
      value: {
        chips: ["sharing a tiny espresso bar", "napping in a sunbeam"],
        promptVersion: "chips.v1",
      },
    });
    expect(calls[0].url).toBe("https://api.meta.ai/v1/chat/completions");
    expect(calls[0].body.max_tokens).toBe(DEFAULT_POLICY.maxTokens.sparkChips);
    const messages = calls[0].body.messages as { role: string; content: unknown }[];
    expect(JSON.parse(String(messages[1].content))).toEqual({
      labels: ["Teal Mug", "Orange Tabby Cat"],
    });
  });

  it("mock and fixture suggesters are deterministic, capped and mock-word-free", async () => {
    for (const suggester of [mockChipSuggester, fixtureChipSuggester()]) {
      const first = await suggester.suggestChips(chipsInput());
      const second = await suggester.suggestChips(chipsInput());
      expect(first.status).toBe("ready");
      expect(first).toEqual(second);
      if (first.status === "ready") {
        expect(first.value.chips).toHaveLength(DEFAULT_POLICY.chipsMax);
        expect(first.value.chips.join(" ")).not.toMatch(/mock/i);
        expect(first.value.promptVersion).toBe("chips.v1");
      }
    }
  });
});

describe("sceneImageOutcome refusal mapping (PIN-61 fixtures)", () => {
  it("extracts the image from an image_generation_call item", () => {
    const out = sceneImageOutcome([
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: "done" }] },
      { type: "image_generation_call", result: "aGVsbG8=" },
    ]);
    expect(out).toEqual({ status: "ready", value: { imageBase64: "aGVsbG8=" } });
  });

  it("HTTP 200 with no image item is a refusal, never an error", () => {
    const out = sceneImageOutcome([
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: "I can't make that." }] },
    ]);
    expect(out).toMatchObject({ status: "refused", errorCode: "no_image" });
    expect(sceneImageOutcome([])).toMatchObject({ status: "refused" });
    expect(sceneImageOutcome(undefined)).toMatchObject({ status: "refused" });
    expect(
      sceneImageOutcome([{ type: "image_generation_call", result: "" }]),
    ).toMatchObject({ status: "refused", errorCode: "no_image" });
  });

  it("counts only populated image_generation_call items (PIN-180)", () => {
    expect(
      generatedImageCount([
        { type: "reasoning", summary: [] },
        { type: "image_generation_call", result: "aGVsbG8=" },
        { type: "image_generation_call", result: "" },
        { type: "message", result: "aGVsbG8=" },
        null,
      ]),
    ).toBe(1);
    expect(generatedImageCount([])).toBe(0);
    expect(generatedImageCount(undefined)).toBe(0);
    expect(generatedImageCount({ type: "image_generation_call", result: "x" })).toBe(0);
  });
});
