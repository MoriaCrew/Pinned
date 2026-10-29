import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AiCallLog } from "../domain/types";
import { DEFAULT_POLICY } from "../policy/policy";
import { InMemoryBudgetStore } from "./budget";
import { collectMetaCallLog, decoratePorts } from "./decorators";
import { fixtureSceneComposer, type StudioFixtures } from "./fixture-ports";
import { MetaGateway } from "./meta-gateway";
import { metaSceneComposer } from "./meta-ports";
import { mockElementNamer, mockSceneComposer, mockSegmenter } from "./mock-ports";
import {
  buildSceneResponsesBody,
  sceneElementLabel,
  scenePromptText,
  type ComposeSceneInput,
} from "./ports";

const fixtures = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "eval/fixtures/studio/fixtures.json"),
    "utf8",
  ),
) as StudioFixtures;

const composeFixture = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "eval/fixtures/studio/compose-response.fixture.json"),
    "utf8",
  ),
) as { sceneId: string; response: Record<string, unknown> };

function composeInput(over: Partial<ComposeSceneInput> = {}): ComposeSceneInput {
  const p = DEFAULT_POLICY;
  return {
    elements: [
      {
        label: "Rustic Teal Mug",
        description: "distressed turquoise glaze with worn white base",
        imageRef: "data:image/jpeg;base64,TEALMUGFLAT",
        from: "Robin",
      },
      {
        label: "Rubber Duck",
        description: "small yellow duck wearing black sunglasses",
        imageRef: "data:image/jpeg;base64,DUCKFLAT",
        from: "Aye",
      },
    ],
    prompt: "a sunny picnic blanket on grass with these things on it",
    size: p.sceneSize,
    store: p.sceneStore,
    timeoutMs: p.timeoutsMs.scene,
    promptVersion: p.promptVersions.scene,
    sceneInputMode: p.sceneInputMode,
    boardId: "board-1",
    participantId: "participant-1",
    ...over,
  };
}

type WireBody = {
  model: string;
  store: boolean;
  input: { role: string; content: Record<string, unknown>[] }[];
  tools: Record<string, unknown>[];
};

function metaComposer(handler: () => unknown, status = 200) {
  const calls: { url: string; body: WireBody }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as WireBody,
    });
    return new Response(JSON.stringify(handler()), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const gateway = new MetaGateway({
    apiKey: "test-key",
    baseUrl: "https://api.meta.ai/v1",
    sparkModel: DEFAULT_POLICY.models.spark,
    samModel: DEFAULT_POLICY.models.sam,
    imageModel: DEFAULT_POLICY.models.image,
    fetchFn,
  });
  return { calls, composer: metaSceneComposer(gateway) };
}

describe("scene builder (PIN-68, docs/11 sections 3 + 5.6)", () => {
  it("emits the documented wrapper: label+image per element, prompt last", () => {
    const built = buildSceneResponsesBody(composeInput(), "muse-image-1.0");
    expect(built.status).toBe("ready");
    if (built.status !== "ready") return;
    const body = built.value;
    expect(body.model).toBe("muse-image-1.0");
    expect(body.store).toBe(false);
    expect(body.input).toHaveLength(1);
    expect(body.input[0].role).toBe("user");
    const content = body.input[0].content;
    expect(content.map((part) => part.type)).toEqual([
      "input_text",
      "input_image",
      "input_text",
      "input_image",
      "input_text",
    ]);
    expect(content[0]).toEqual({
      type: "input_text",
      text: "Element 1 (from Robin): Rustic Teal Mug — distressed turquoise glaze with worn white base",
    });
    expect(content[1]).toEqual({
      type: "input_image",
      image_url: "data:image/jpeg;base64,TEALMUGFLAT",
    });
    expect(content[2]).toEqual({
      type: "input_text",
      text: "Element 2 (from Aye): Rubber Duck — small yellow duck wearing black sunglasses",
    });
    expect(content[4]).toEqual({
      type: "input_text",
      text: "Compose these exact elements into one new photorealistic scene, keeping each element recognisable: a sunny picnic blanket on grass with these things on it",
    });
  });

  it("carries only the documented keys and the Policy size tool", () => {
    const built = buildSceneResponsesBody(composeInput(), "muse-image-1.0");
    expect(built.status).toBe("ready");
    if (built.status !== "ready") return;
    const body = built.value as unknown as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["input", "model", "store", "tools"]);
    expect(built.value.tools).toEqual([
      { type: "image_generation", size: "1024x1536" },
    ]);
    expect(Object.keys(built.value.tools[0]).sort()).toEqual(["size", "type"]);
    expect(Object.keys(built.value.input[0]).sort()).toEqual(["content", "role"]);
    for (const part of built.value.input[0].content) {
      expect(Object.keys(part).sort()).toEqual(
        part.type === "input_text" ? ["text", "type"] : ["image_url", "type"],
      );
    }
    // Never leak port-only fields onto the wire.
    const wire = JSON.stringify(built.value);
    for (const key of [
      "sceneInputMode",
      "promptVersion",
      "boardId",
      "participantId",
      "output_format",
      "reasoning_strength",
      "previous_response_id",
    ]) {
      expect(wire).not.toContain(key);
    }
  });

  it("passes store and size through verbatim from the caller (Policy)", () => {
    const off = buildSceneResponsesBody(
      composeInput({ store: false, size: "1024x1024" }),
      "m",
    );
    expect(off.status).toBe("ready");
    if (off.status === "ready") {
      expect(off.value.store).toBe(false);
      expect(off.value.tools[0].size).toBe("1024x1024");
    }
    const on = buildSceneResponsesBody(composeInput({ store: true }), "m");
    expect(on.status).toBe("ready");
    if (on.status === "ready") expect(on.value.store).toBe(true);
  });

  it("labels without an owner and without a duplicate description", () => {
    expect(
      sceneElementLabel(
        { label: "Teal Mug", description: "teal mug", imageRef: "x" },
        0,
      ),
    ).toBe("Element 1: Teal Mug");
    expect(scenePromptText("  on a boat  ")).toBe(
      "Compose these exact elements into one new photorealistic scene, keeping each element recognisable: on a boat",
    );
  });

  it("rejects bad caller input as failed/bad_prompt without throwing", () => {
    const model = "muse-image-1.0";
    expect(buildSceneResponsesBody(composeInput({ elements: [] }), model)).toMatchObject({
      status: "failed",
      errorCode: "bad_prompt",
    });
    expect(buildSceneResponsesBody(composeInput({ prompt: "  " }), model)).toMatchObject({
      status: "failed",
      errorCode: "bad_prompt",
    });
    expect(buildSceneResponsesBody(composeInput({ size: "big" }), model)).toMatchObject({
      status: "failed",
      errorCode: "bad_prompt",
    });
    expect(buildSceneResponsesBody(composeInput(), " ")).toMatchObject({
      status: "failed",
      errorCode: "bad_prompt",
    });
    expect(
      buildSceneResponsesBody(
        composeInput({
          elements: [{ label: "X", description: "d", imageRef: "" }],
        }),
        model,
      ),
    ).toMatchObject({ status: "failed", errorCode: "bad_prompt" });
  });
});

describe("meta scene composer (fake fetch)", () => {
  it("posts to /responses and parses image_generation_call.result", async () => {
    const { calls, composer } = metaComposer(() => composeFixture.response);
    const out = await composer.composeScene(composeInput());
    expect(out.status).toBe("ready");
    if (out.status !== "ready") return;
    expect(out.value.promptVersion).toBe("scene.v1");
    const bytes = Buffer.from(out.value.imageBase64 ?? "", "base64");
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.meta.ai/v1/responses");
    expect(calls[0].body.tools).toEqual([
      { type: "image_generation", size: DEFAULT_POLICY.sceneSize },
    ]);
    expect(calls[0].body.store).toBe(DEFAULT_POLICY.sceneStore);
  });

  it("HTTP 200 with no image item is refused, never failed", async () => {
    const { composer } = metaComposer(() => ({
      output: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          content: [{ type: "output_text", text: "I can't make that." }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const out = await composer.composeScene(composeInput());
    expect(out).toMatchObject({ status: "refused", errorCode: "no_image" });
  });

  it("maps provider errors: content policy refused, 500 failed+status", async () => {
    const refused = metaComposer(
      () => ({ error: { code: "content_policy", message: "refused by content policy" } }),
      400,
    );
    expect(await refused.composer.composeScene(composeInput())).toMatchObject({
      status: "refused",
      errorCode: "content_policy",
    });
    const failed = metaComposer(
      () => ({ error: { code: "http_500", message: "boom" } }),
      500,
    );
    expect(await failed.composer.composeScene(composeInput())).toMatchObject({
      status: "failed",
      httpStatus: 500,
    });
  });

  it("never calls the provider for invalid input", async () => {
    const { calls, composer } = metaComposer(() => composeFixture.response);
    const out = await composer.composeScene(composeInput({ elements: [] }));
    expect(out).toMatchObject({ status: "failed", errorCode: "bad_prompt" });
    expect(calls).toHaveLength(0);
  });
});

describe("fixture + mock scene composers", () => {
  it("replays the recorded C1-flattened scene by id and by default", async () => {
    const composer = fixtureSceneComposer(fixtures);
    const byId = await composer.composeScene(
      composeInput({ fixtureSceneId: "C1-flattened" }),
    );
    expect(byId).toMatchObject({
      status: "ready",
      value: {
        imageRef: "eval/fixtures/studio/scenes/C1-flattened.jpg",
        promptVersion: "scene.v1",
      },
    });
    const byDefault = await composer.composeScene(composeInput());
    expect(byDefault.status).toBe("ready");
    if (byDefault.status === "ready") {
      expect(byDefault.value.imageRef).toMatch(/eval\/fixtures\/studio\/scenes\/.+\.jpg$/);
    }
    expect(composeFixture.sceneId).toBe("C1-flattened");
  });

  it("fails (not throws) for an unknown fixture scene", async () => {
    const composer = fixtureSceneComposer(fixtures);
    const out = await composer.composeScene(
      composeInput({ fixtureSceneId: "nope" }),
    );
    expect(out).toMatchObject({ status: "failed", errorCode: "fixture_not_found" });
  });

  it("mock returns a decodable PNG with no mock marker", async () => {
    const out = await mockSceneComposer.composeScene(composeInput());
    expect(out.status).toBe("ready");
    if (out.status !== "ready") return;
    expect(JSON.stringify(out.value)).not.toContain("(mock)");
    const bytes = Buffer.from(out.value.imageBase64 ?? "", "base64");
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const bad = await mockSceneComposer.composeScene(composeInput({ elements: [] }));
    expect(bad).toMatchObject({ status: "failed", errorCode: "bad_prompt" });
  });
});

describe("decorated scene composer (PIN-61 chain)", () => {
  it("a provider refusal stays refused with a refused AiCallLog", async () => {
    const logs: AiCallLog[] = [];
    const { composer } = metaComposer(() => ({
      output: [{ type: "message", content: [{ type: "output_text", text: "no" }] }],
      usage: { input_tokens: 100, output_tokens: 10 },
    }));
    const ports = decoratePorts(
      { elementNamer: mockElementNamer, segmenter: mockSegmenter, sceneComposer: composer },
      {
        policy: DEFAULT_POLICY,
        budget: new InMemoryBudgetStore(),
        appendLog: async (log) => {
          logs.push(log);
        },
        now: () => Date.UTC(2026, 9, 29, 12, 0, 0),
      },
    );
    void collectMetaCallLog;
    const out = await ports.sceneComposer!.composeScene(composeInput());
    expect(out).toMatchObject({ status: "refused", errorCode: "no_image" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      operation: "composeScene",
      promptVersion: "scene.v1",
      outcome: "refused",
    });
  });
});
