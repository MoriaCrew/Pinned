import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AiCallLog } from "../domain/types";
import { DEFAULT_POLICY, resolvePolicy } from "../policy/policy";
import { InMemoryBudgetStore, dayBucketFor } from "./budget";
import { decoratePorts } from "./decorators";
import {
  fixtureTapNamer,
  type StudioFixtures,
} from "./fixture-ports";
import { MetaGateway } from "./meta-gateway";
import { metaTapNamer } from "./meta-ports";
import { MOCK_TAP_NAME, mockTapNamer } from "./mock-ports";
import { mockElementNamer, mockSegmenter } from "./mock-ports";
import {
  normalizeTapName,
  tapNameSystemPrompt,
  type NameOneInput,
} from "./ports";

const fixtures = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "eval/fixtures/studio/fixtures.json"),
    "utf8",
  ),
) as StudioFixtures;

function nameOneInput(over: Partial<NameOneInput> = {}): NameOneInput {
  const p = DEFAULT_POLICY;
  return {
    imageRef: "data:image/jpeg;base64,x",
    conceptMaxWords: p.conceptMaxWords,
    maxTokens: p.maxTokens.sparkTapName,
    timeoutMs: p.timeoutsMs.spark,
    promptVersion: p.promptVersions.tapName,
    ...over,
  };
}

function metaGateway(handler: () => unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify(handler()), {
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

describe("tap-name prompt + normalize (PIN-117)", () => {
  it("system prompt is prompts/tap-name.v1.md above the rule, Policy cap in the slot", () => {
    const file = readFileSync(
      path.join(process.cwd(), "prompts/tap-name.v1.md"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const aboveRule = file.split("\n---\n")[0].trimEnd();
    expect(tapNameSystemPrompt({ conceptMaxWords: 3 })).toBe(
      aboveRule.replaceAll("{{CONCEPT_MAX_WORDS}}", "3"),
    );
  });

  it("normalizeTapName truncates to the word cap and defaults description", () => {
    expect(
      normalizeTapName(
        { label: "  Big   Red Alarm Clock Extra ", faceFlag: true },
        { conceptMaxWords: 3 },
      ),
    ).toEqual({
      label: "Big Red Alarm",
      description: "Big Red Alarm",
      faceFlag: true,
    });
    expect(
      normalizeTapName({ label: "Teal Mug", description: "worn glaze", faceFlag: "yes" }, { conceptMaxWords: 3 }),
    ).toEqual({ label: "Teal Mug", description: "worn glaze", faceFlag: false });
  });

  it("normalizeTapName returns null without a usable label", () => {
    expect(normalizeTapName({ label: "   " }, { conceptMaxWords: 3 })).toBeNull();
    expect(normalizeTapName({}, { conceptMaxWords: 3 })).toBeNull();
    expect(normalizeTapName("nope", { conceptMaxWords: 3 })).toBeNull();
    expect(normalizeTapName(null, { conceptMaxWords: 3 })).toBeNull();
  });
});

describe("tap-name adapters (PIN-117)", () => {
  it("mock returns the stable synthetic name, no mock marker", async () => {
    const out = await mockTapNamer.nameOne(nameOneInput());
    expect(out).toEqual({
      status: "ready",
      value: { name: MOCK_TAP_NAME, promptVersion: "tap-name.v1" },
    });
    expect(JSON.stringify(out)).not.toContain("(mock)");
  });

  it("fixture replays the first recorded element's name", async () => {
    const out = await fixtureTapNamer(fixtures).nameOne(nameOneInput());
    expect(out.status).toBe("ready");
    if (out.status !== "ready") return;
    const first = fixtures.elements[0];
    expect(out.value.name.label).toBe(first.label);
    expect(out.value.name.faceFlag).toBe(first.faceFlag);
  });

  it("meta parses Spark JSON and sends the tap-name token budget", async () => {
    const { calls, gateway } = metaGateway(() => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              label: "Orange Tabby Cat",
              description: "striped ginger cat, torn ear",
              faceFlag: false,
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8 },
    }));
    const out = await metaTapNamer(gateway).nameOne(nameOneInput());
    expect(out).toEqual({
      status: "ready",
      value: {
        name: {
          label: "Orange Tabby Cat",
          description: "striped ginger cat, torn ear",
          faceFlag: false,
        },
        promptVersion: "tap-name.v1",
      },
    });
    expect(calls[0].url).toBe("https://api.meta.ai/v1/chat/completions");
    expect(calls[0].body.max_tokens).toBe(DEFAULT_POLICY.maxTokens.sparkTapName);
  });

  it("meta maps an unusable label to a failed outcome, never a throw", async () => {
    const { gateway } = metaGateway(() => ({
      choices: [{ message: { content: JSON.stringify({ label: "" }) } }],
    }));
    const out = await metaTapNamer(gateway).nameOne(nameOneInput());
    expect(out).toMatchObject({ status: "failed", errorCode: "bad_tap_name" });
  });
});

describe("decorated TapNamer (PIN-117)", () => {
  const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

  function decorated(policy = resolvePolicy()) {
    const budget = new InMemoryBudgetStore();
    const logs: AiCallLog[] = [];
    let calls = 0;
    const base = {
      async nameOne(input: NameOneInput) {
        calls += 1;
        return {
          status: "ready" as const,
          value: {
            name: { label: "Teal Mug", description: "worn glaze", faceFlag: false },
            promptVersion: input.promptVersion,
          },
        };
      },
    };
    const ports = decoratePorts(
      { elementNamer: mockElementNamer, segmenter: mockSegmenter, tapNamer: base },
      {
        policy,
        budget,
        appendLog: async (log) => {
          logs.push(log);
        },
        now: () => NOW,
        sleep: async () => undefined,
        newId: () => "log-1",
        onLogError: () => undefined,
      },
    );
    return { ports, budget, logs, calls: () => calls };
  }

  it("reserves under participantTapNames (not the photo quota) and cost-logs nameOne", async () => {
    const { ports, budget, logs } = decorated();
    const out = await ports.tapNamer!.nameOne(
      nameOneInput({ participantId: "p1", boardId: "b1" }),
    );
    expect(out.status).toBe("ready");
    const snap = budget.snapshot(dayBucketFor(NOW));
    expect(snap.participantTapNames).toEqual({ p1: 1 });
    expect(snap.participants).toEqual({});
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      operation: "nameOne",
      promptVersion: "tap-name.v1",
      outcome: "ok",
    });
  });

  it("denies at the Policy tap-name cap before any provider call", async () => {
    const { ports, calls } = decorated(
      resolvePolicy({ tapNamesPerParticipantPerDay: 1 }),
    );
    const input = nameOneInput({ participantId: "p1" });
    expect((await ports.tapNamer!.nameOne(input)).status).toBe("ready");
    const denied = await ports.tapNamer!.nameOne(input);
    expect(denied).toMatchObject({ status: "failed", errorCode: "participant_cap" });
    expect(calls()).toBe(1);
  });
});
