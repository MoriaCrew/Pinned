import { describe, expect, it } from "vitest";
import type { AiCallLog } from "../domain/types";
import { DEFAULT_POLICY, resolvePolicy, type Policy } from "../policy/policy";
import {
  InMemoryBudgetStore,
  type BudgetStore,
  type ReserveRequest,
} from "./budget";
import { collectMetaCallLog, decoratePorts } from "./decorators";
import type {
  ElementNamer,
  NameElementsInput,
  PortOutcome,
  SceneComposer,
  ChipSuggester,
  Segmenter,
} from "./ports";

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const DAY = "2026-10-29";

function namerInput(over: Partial<NameElementsInput> = {}): NameElementsInput {
  return {
    imageRef: "data:image/webp;base64,x",
    minElements: 1,
    maxElements: 6,
    conceptMaxWords: 3,
    labelMaxChars: DEFAULT_POLICY.elementLabelMaxChars,
    maxTokens: 4000,
    timeoutMs: 30_000,
    promptVersion: "elements.v1",
    ...over,
  };
}

type ElementsOut = { elements: never[]; promptVersion: string };
const READY: PortOutcome<ElementsOut> = {
  status: "ready",
  value: { elements: [], promptVersion: "elements.v1" },
};

function setup(
  namer: ElementNamer,
  opts: {
    policy?: Policy;
    budget?: BudgetStore;
    appendLog?: (log: AiCallLog) => Promise<void>;
    onLogError?: (cause: unknown) => void;
    composer?: SceneComposer;
    suggester?: ChipSuggester;
    segmenter?: Segmenter;
  } = {},
) {
  const logs: AiCallLog[] = [];
  const sleeps: number[] = [];
  const segmenter: Segmenter = opts.segmenter ?? {
    async segment() {
      return { status: "ready", value: { segments: [] } };
    },
  };
  const ports = decoratePorts(
    { elementNamer: namer, segmenter, sceneComposer: opts.composer, chipSuggester: opts.suggester },
    {
      policy: opts.policy ?? resolvePolicy(),
      budget: opts.budget ?? new InMemoryBudgetStore(),
      appendLog:
        opts.appendLog ??
        (async (log) => {
          logs.push(log);
        }),
      now: () => NOW,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      newId: () => "log-1",
      onLogError: opts.onLogError ?? (() => undefined),
    },
  );
  return { ports, logs, sleeps };
}

describe("decorator chain: budget (PIN-61)", () => {
  it("budget 0 = off -> friendly failed outcome, provider never called, no mock swap", async () => {
    let calls = 0;
    const { ports, logs } = setup(
      {
        async nameElements() {
          calls += 1;
          return READY;
        },
      },
      { policy: resolvePolicy({ dailyBudgetUsd: 0 }) },
    );
    const out = await ports.elementNamer.nameElements(namerInput());
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.errorCode).toBe("budget_off");
      expect(out.message).toContain("switched off");
    }
    expect(calls).toBe(0);
    // PIN-137: the denial itself is logged as denied_off.
    expect(logs).toMatchObject([{ outcome: "denied_off", denialReason: "off", attempts: 0, reservedMicroUsd: 0 }]);
  });

  it("fail closed when the budget store errors: no provider call", async () => {
    let calls = 0;
    const broken: BudgetStore = {
      async reserve() {
        throw new Error("firestore unavailable");
      },
    };
    const { ports } = setup(
      {
        async nameElements() {
          calls += 1;
          return READY;
        },
      },
      { budget: broken },
    );
    const out = await ports.elementNamer.nameElements(namerInput());
    expect(out).toMatchObject({ status: "failed", errorCode: "budget_unavailable" });
    expect(calls).toBe(0);
  });

  it("per-participant cap denies the (cap+1)th photo for that participant only", async () => {
    const { ports } = setup(
      { async nameElements() { return READY; } },
      { policy: resolvePolicy({ photosPerParticipantPerDay: 1 }) },
    );
    const first = await ports.elementNamer.nameElements(
      namerInput({ participantId: "p1", boardId: "b1" }),
    );
    const second = await ports.elementNamer.nameElements(
      namerInput({ participantId: "p1", boardId: "b1" }),
    );
    const other = await ports.elementNamer.nameElements(
      namerInput({ participantId: "p2", boardId: "b1" }),
    );
    expect(first.status).toBe("ready");
    expect(second).toMatchObject({ status: "failed", errorCode: "participant_cap" });
    expect(other.status).toBe("ready");
  });

  it("PIN-136: scenes do not consume the photo quota and vice versa", async () => {
    const composer: SceneComposer = {
      async composeScene(input) {
        return { status: "ready", value: { imageBase64: "x", promptVersion: input.promptVersion } };
      },
    };
    const budget = new InMemoryBudgetStore();
    const { ports } = setup(
      { async nameElements() { return READY; } },
      {
        budget,
        composer,
        policy: resolvePolicy({
          photosPerParticipantPerDay: 2,
          scenesPerParticipantPerDay: 2,
          scenesPerBoardPerDay: 100,
        }),
      },
    );
    const sceneInput = {
      elements: [],
      prompt: "s",
      size: "1024x1536",
      store: false,
      timeoutMs: 120_000,
      promptVersion: "scene.v1",
      labelMaxChars: DEFAULT_POLICY.elementLabelMaxChars,
      boardId: "b1",
      participantId: "p1",
    };
    // Exhaust scenes; photos still have their full quota.
    expect((await ports.sceneComposer!.composeScene(sceneInput)).status).toBe("ready");
    expect((await ports.sceneComposer!.composeScene(sceneInput)).status).toBe("ready");
    expect(await ports.sceneComposer!.composeScene(sceneInput)).toMatchObject({
      status: "failed",
      errorCode: "participant_cap",
    });
    expect(
      (await ports.elementNamer.nameElements(namerInput({ participantId: "p1", boardId: "b1" }))).status,
    ).toBe("ready");
    expect(
      (await ports.elementNamer.nameElements(namerInput({ participantId: "p1", boardId: "b1" }))).status,
    ).toBe("ready");
    expect(
      await ports.elementNamer.nameElements(namerInput({ participantId: "p1", boardId: "b1" })),
    ).toMatchObject({ status: "failed", errorCode: "participant_cap" });
    const snap = budget.snapshot(DAY);
    expect(snap.participantScenes).toEqual({ p1: 2 });
    expect(snap.participantPhotos).toEqual({ p1: 2 });
  });

  it("RACE: reservation holds while the first call is still pending -> exactly 1 proceeds", async () => {
    let release!: (out: PortOutcome<ElementsOut>) => void;
    const gate = new Promise<PortOutcome<ElementsOut>>((r) => {
      release = r;
    });
    let providerCalls = 0;
    const { ports } = setup(
      {
        async nameElements() {
          providerCalls += 1;
          return gate;
        },
      },
      { policy: resolvePolicy({ dailyCallLimit: 1 }) },
    );
    const firstPromise = ports.elementNamer.nameElements(namerInput());
    // Let the first call reserve + enter the (blocked) provider.
    await new Promise((r) => setTimeout(r, 0));
    expect(providerCalls).toBe(1);
    // The second call must be denied NOW, while call 1 is in flight.
    const second = await ports.elementNamer.nameElements(namerInput());
    expect(second).toMatchObject({ status: "failed", errorCode: "call_limit" });
    expect(providerCalls).toBe(1);
    release(READY);
    const first = await firstPromise;
    expect(first.status).toBe("ready");
  });
});

describe("decorator chain: timeout + retry (PIN-61)", () => {
  it("retries once on 429 with Policy backoff, then succeeds", async () => {
    let attempts = 0;
    const { ports, sleeps } = setup({
      async nameElements() {
        attempts += 1;
        return attempts === 1
          ? { status: "failed", errorCode: "http_429", httpStatus: 429 }
          : READY;
      },
    });
    const out = await ports.elementNamer.nameElements(namerInput());
    expect(out.status).toBe("ready");
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([resolvePolicy().retryBackoffMs]);
  });

  it("retries 5xx via errorCode when no httpStatus is present", async () => {
    let attempts = 0;
    const { ports } = setup({
      async nameElements() {
        attempts += 1;
        return attempts === 1
          ? { status: "failed", errorCode: "http_503" }
          : READY;
      },
    });
    expect((await ports.elementNamer.nameElements(namerInput())).status).toBe("ready");
    expect(attempts).toBe(2);
  });

  it("does not retry non-retryable failures or refusals; Policy retries=0 disables retry", async () => {
    let attempts = 0;
    const bad = setup({
      async nameElements() {
        attempts += 1;
        return { status: "failed", errorCode: "bad_json", httpStatus: 400 };
      },
    });
    expect((await bad.ports.elementNamer.nameElements(namerInput())).status).toBe("failed");
    expect(attempts).toBe(1);

    let refusedAttempts = 0;
    const refused = setup({
      async nameElements() {
        refusedAttempts += 1;
        return { status: "refused", errorCode: "content_policy" };
      },
    });
    expect((await refused.ports.elementNamer.nameElements(namerInput())).status).toBe("refused");
    expect(refusedAttempts).toBe(1);

    let noRetryAttempts = 0;
    const noRetry = setup(
      {
        async nameElements() {
          noRetryAttempts += 1;
          return { status: "failed", errorCode: "http_500", httpStatus: 500 };
        },
      },
      { policy: resolvePolicy({ retries: 0 }) },
    );
    await noRetry.ports.elementNamer.nameElements(namerInput());
    expect(noRetryAttempts).toBe(1);
  });

  it("times out a hung call as failed/timeout and never retries it", async () => {
    let attempts = 0;
    const { ports, logs } = setup({
      async nameElements() {
        attempts += 1;
        return new Promise<never>(() => undefined);
      },
    });
    const out = await ports.elementNamer.nameElements(namerInput({ timeoutMs: 5 }));
    expect(out).toMatchObject({ status: "failed", errorCode: "timeout" });
    expect(attempts).toBe(1);
    expect(logs).toMatchObject([{ outcome: "error", operation: "nameElements" }]);
  });

  it("a throwing adapter becomes a classified outcome, not a throw", async () => {
    const { ports } = setup({
      async nameElements() {
        throw Object.assign(new Error("refused by content policy"), {
          code: "content_policy",
          status: 400,
        });
      },
    });
    const out = await ports.elementNamer.nameElements(namerInput());
    expect(out).toMatchObject({ status: "refused", errorCode: "content_policy" });
  });
});

describe("decorator chain: ChipSuggester (PIN-75)", () => {
  const chipsInput = {
    labels: ["Teal Mug"],
    maxChips: 4,
    maxChipChars: 500,
    maxTokens: 1200,
    timeoutMs: 30_000,
    promptVersion: "chips.v1",
    boardId: "b1",
    participantId: "p1",
  };

  it("budget off denies before the provider; ready calls log suggestChips + chips.v1", async () => {
    let calls = 0;
    const suggester: ChipSuggester = {
      async suggestChips(input) {
        calls += 1;
        return {
          status: "ready",
          value: { chips: ["in space"], promptVersion: input.promptVersion },
        };
      },
    };
    const off = setup(
      { async nameElements() { return READY; } },
      { suggester, policy: resolvePolicy({ dailyBudgetUsd: 0 }) },
    );
    expect(await off.ports.chipSuggester!.suggestChips(chipsInput)).toMatchObject({
      status: "failed",
      errorCode: "budget_off",
    });
    expect(calls).toBe(0);

    const on = setup(
      { async nameElements() { return READY; } },
      { suggester },
    );
    expect((await on.ports.chipSuggester!.suggestChips(chipsInput)).status).toBe("ready");
    expect(calls).toBe(1);
    expect(on.logs).toMatchObject([
      { operation: "suggestChips", promptVersion: "chips.v1", outcome: "ok" },
    ]);
  });

  it("reserve is priced from the small chips token budget", async () => {
    const seen: ReserveRequest[] = [];
    const spy: BudgetStore = {
      async reserve(request) {
        seen.push(request);
        return { ok: true, estimatedMicroUsd: 1 };
      },
    };
    const { ports } = setup(
      { async nameElements() { return READY; } },
      {
        budget: spy,
        suggester: {
          async suggestChips(input) {
            return { status: "ready", value: { chips: ["x"], promptVersion: input.promptVersion } };
          },
        },
      },
    );
    await ports.chipSuggester!.suggestChips(chipsInput);
    // 1200 output tokens at the Spark list rate: $0.0051 < $0.01.
    expect(seen[0].estimatedCostUsd).toBeCloseTo(0.0051, 6);
  });
});

describe("decorator chain: Segmenter caps (PIN-92)", () => {
  const segInput = (over: Record<string, unknown> = {}) => ({
    imageRef: "x",
    prompt: { kind: "concept", concept: "teal mug" } as const,
    timeoutMs: 20_000,
    boardId: "b1",
    participantId: "p1",
    photoId: "job-1",
    ...over,
  });
  const readySegmenter = (counter: { calls: number }): Segmenter => ({
    async segment() {
      counter.calls += 1;
      return { status: "ready", value: { segments: [] } };
    },
  });

  it("per-participant segment cap binds SAM calls; the namer photo quota is a separate counter", async () => {
    const counter = { calls: 0 };
    const budget = new InMemoryBudgetStore();
    const { ports } = setup(
      { async nameElements() { return READY; } },
      {
        budget,
        segmenter: readySegmenter(counter),
        policy: resolvePolicy({
          segmentsPerParticipantPerDay: 2,
          photosPerParticipantPerDay: 1,
        }),
      },
    );
    expect((await ports.segmenter.segment(segInput())).status).toBe("ready");
    expect((await ports.segmenter.segment(segInput())).status).toBe("ready");
    expect(await ports.segmenter.segment(segInput())).toMatchObject({
      status: "failed",
      errorCode: "participant_cap",
    });
    expect(counter.calls).toBe(2); // denied before the provider
    // SAM spend did not eat the photo quota, and vice versa.
    expect(
      (await ports.elementNamer.nameElements(namerInput({ participantId: "p1", boardId: "b1" }))).status,
    ).toBe("ready");
    expect(
      await ports.elementNamer.nameElements(namerInput({ participantId: "p1", boardId: "b1" })),
    ).toMatchObject({ status: "failed", errorCode: "participant_cap" });
    // Another participant still segments.
    expect(
      (await ports.segmenter.segment(segInput({ participantId: "p2" }))).status,
    ).toBe("ready");
    const snap = budget.snapshot(DAY);
    expect(snap.participantPhotos).toEqual({ p1: 1 });
    expect(snap.participantScenes).toEqual({});
    expect(snap.participantSegments).toEqual({ p1: 2, p2: 1 });
    expect(snap.photos).toEqual({ "job-1": 3 });
    expect(snap.calls).toBe(4);
  });

  it("per-photo cap binds concept + tap prompts on one photo; other photos unaffected", async () => {
    const counter = { calls: 0 };
    const { ports } = setup(
      { async nameElements() { return READY; } },
      {
        segmenter: readySegmenter(counter),
        policy: resolvePolicy({ segmentsPerPhoto: 2 }),
      },
    );
    expect((await ports.segmenter.segment(segInput())).status).toBe("ready");
    const tap = segInput({
      prompt: {
        kind: "point",
        points: [{ x: 0.5, y: 0.5, label: "positive" }],
        frame: { width: 100, height: 100 },
      },
    });
    expect((await ports.segmenter.segment(tap)).status).toBe("ready");
    expect(await ports.segmenter.segment(tap)).toMatchObject({
      status: "failed",
      errorCode: "photo_cap",
    });
    expect(counter.calls).toBe(2);
    expect(
      (await ports.segmenter.segment(segInput({ photoId: "job-2" }))).status,
    ).toBe("ready");
  });

  it("failures and refusals consume the cap; every provider call is still logged", async () => {
    const outcomes: PortOutcome<{ segments: never[] }>[] = [
      { status: "failed", errorCode: "bad_prompt" },
      { status: "refused", errorCode: "content_policy" },
      { status: "ready", value: { segments: [] } },
    ];
    let calls = 0;
    const segmenter: Segmenter = {
      async segment() {
        const out = outcomes[calls];
        calls += 1;
        return out;
      },
    };
    const { ports, logs } = setup(
      { async nameElements() { return READY; } },
      { segmenter, policy: resolvePolicy({ segmentsPerParticipantPerDay: 2 }) },
    );
    expect(await ports.segmenter.segment(segInput())).toMatchObject({
      status: "failed",
      errorCode: "bad_prompt",
    });
    // Typed refusal is preserved, never flattened to a failure.
    expect(await ports.segmenter.segment(segInput())).toMatchObject({
      status: "refused",
      errorCode: "content_policy",
    });
    expect(await ports.segmenter.segment(segInput())).toMatchObject({
      status: "failed",
      errorCode: "participant_cap",
    });
    expect(calls).toBe(2);
    expect(logs.map((l) => [l.operation, l.outcome])).toEqual([
      ["segment", "error"],
      ["segment", "refused"],
      ["segment", "denied_participant_cap"], // PIN-137: cap denial logged
    ]);
  });

  it("retry attempts reserve again: one 429 + retry burns two segment slots", async () => {
    let attempts = 0;
    const segmenter: Segmenter = {
      async segment() {
        attempts += 1;
        return attempts === 1
          ? { status: "failed", errorCode: "http_429", httpStatus: 429 }
          : { status: "ready", value: { segments: [] } };
      },
    };
    const budget = new InMemoryBudgetStore();
    const { ports } = setup(
      { async nameElements() { return READY; } },
      { budget, segmenter, policy: resolvePolicy({ segmentsPerParticipantPerDay: 2 }) },
    );
    expect((await ports.segmenter.segment(segInput())).status).toBe("ready");
    expect(attempts).toBe(2);
    expect(budget.snapshot(DAY).participantSegments).toEqual({ p1: 2 });
    expect(budget.snapshot(DAY).photos).toEqual({ "job-1": 2 });
    expect(await ports.segmenter.segment(segInput())).toMatchObject({
      status: "failed",
      errorCode: "participant_cap",
    });
    expect(attempts).toBe(2);
  });

  it("a retry denied by the cap returns the friendly denial and still logs the attempt that ran", async () => {
    let attempts = 0;
    const segmenter: Segmenter = {
      async segment() {
        attempts += 1;
        return { status: "failed", errorCode: "http_503", httpStatus: 503 };
      },
    };
    const { ports, logs } = setup(
      { async nameElements() { return READY; } },
      { segmenter, policy: resolvePolicy({ segmentsPerParticipantPerDay: 1 }) },
    );
    const out = await ports.segmenter.segment(segInput());
    expect(out).toMatchObject({ status: "failed", errorCode: "participant_cap" });
    if (out.status === "failed") expect(out.message).toContain("limit");
    expect(attempts).toBe(1);
    expect(logs).toMatchObject([{ operation: "segment", outcome: "denied_participant_cap", attempts: 1 }]);
  });
});

describe("decorator chain: AiCallLog (PIN-61)", () => {
  it("logs promptVersion + priced cost from collected Meta usage", async () => {
    const { ports, logs } = setup({
      async nameElements() {
        collectMetaCallLog({
          operation: "nameElements",
          model: "muse-spark-1.3",
          latencyMs: 10,
          outcome: "ok",
          inputTokens: 2_414,
          outputTokens: 1_954,
        });
        return READY;
      },
    });
    await ports.elementNamer.nameElements(
      namerInput({ boardId: "board-slug-1", participantId: "p1" }),
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      operation: "nameElements",
      model: "muse-spark-1.3",
      promptVersion: "elements.v1",
      gameId: "board-slug-1",
      outcome: "ok",
      dayBucket: DAY,
      inputTokens: 2_414,
      outputTokens: 1_954,
    });
    expect(logs[0].costEstimateUsd).toBeCloseTo(0.011322, 6);
  });

  it("logs refusals as outcome refused; segment logs carry SAM image cost", async () => {
    const refusedComposer: SceneComposer = {
      async composeScene() {
        return { status: "refused", errorCode: "no_image" };
      },
    };
    const { ports, logs } = setup(
      { async nameElements() { return READY; } },
      { composer: refusedComposer },
    );
    const out = await ports.sceneComposer!.composeScene({
      elements: [],
      prompt: "a scene",
      size: "1024x1536",
      store: false,
      timeoutMs: 120_000,
      promptVersion: "scene.v1",
      labelMaxChars: DEFAULT_POLICY.elementLabelMaxChars,
      boardId: "b1",
      participantId: "p1",
    });
    expect(out.status).toBe("refused");
    expect(logs).toMatchObject([
      { operation: "composeScene", promptVersion: "scene.v1", outcome: "refused" },
    ]);
  });

  it("per-board scene cap applies to the composer", async () => {
    const composer: SceneComposer = {
      async composeScene(input) {
        return {
          status: "ready",
          value: { imageBase64: "x", promptVersion: input.promptVersion },
        };
      },
    };
    const { ports } = setup(
      { async nameElements() { return READY; } },
      {
        composer,
        policy: resolvePolicy({ scenesPerBoardPerDay: 1 }),
      },
    );
    const input = {
      elements: [],
      prompt: "s",
      size: "1024x1536",
      store: false,
      timeoutMs: 120_000,
      promptVersion: "scene.v1",
      labelMaxChars: DEFAULT_POLICY.elementLabelMaxChars,
      boardId: "b1",
    };
    expect((await ports.sceneComposer!.composeScene(input)).status).toBe("ready");
    expect(await ports.sceneComposer!.composeScene(input)).toMatchObject({
      status: "failed",
      errorCode: "board_cap",
    });
  });

  it("a failing log write surfaces via onLogError but keeps the outcome", async () => {
    const errors: unknown[] = [];
    const { ports } = setup(
      { async nameElements() { return READY; } },
      {
        appendLog: async () => {
          throw new Error("log write failed");
        },
        onLogError: (cause) => errors.push(cause),
      },
    );
    const out = await ports.elementNamer.nameElements(namerInput());
    expect(out.status).toBe("ready");
    expect(errors).toHaveLength(1);
  });

  it("reserve receives Policy budget/limits and the per-operation estimate", async () => {
    const seen: ReserveRequest[] = [];
    const spy: BudgetStore = {
      async reserve(request) {
        seen.push(request);
        return { ok: true, estimatedMicroUsd: 1 };
      },
    };
    const { ports } = setup(
      { async nameElements() { return READY; } },
      { budget: spy },
    );
    await ports.segmenter.segment({
      imageRef: "x",
      prompt: { kind: "concept", concept: "teal mug" },
      timeoutMs: 20_000,
    });
    const policy = resolvePolicy();
    expect(seen).toMatchObject([
      {
        dayBucket: DAY,
        budgetUsd: policy.dailyBudgetUsd,
        callLimit: policy.dailyCallLimit,
        estimatedCostUsd: 0.0025,
      },
    ]);
  });
});

describe("AiCallLog v2 attribution (PIN-137)", () => {
  it("threads board/participant/user/photo/job + micro-USD + expireAt; link-only user is null", async () => {
    const { ports, logs } = setup({
      async nameElements() {
        collectMetaCallLog({
          operation: "nameElements",
          model: "muse-spark-1.3",
          latencyMs: 5,
          outcome: "ok",
          inputTokens: 100,
          outputTokens: 100,
        });
        return READY;
      },
    });
    await ports.elementNamer.nameElements(
      namerInput({
        boardId: "synthetic-board-1",
        participantId: "p1",
        userIdAtCall: "user-synthetic-1",
        photoId: "job-synthetic-1",
        jobId: "job-synthetic-1",
      }),
    );
    await ports.elementNamer.nameElements(
      namerInput({ boardId: "synthetic-board-1", participantId: "p2" }),
    );
    expect(logs[0]).toMatchObject({
      schemaVersion: 2,
      boardId: "synthetic-board-1",
      gameId: "synthetic-board-1",
      participantId: "p1",
      userIdAtCall: "user-synthetic-1",
      photoId: "job-synthetic-1",
      jobId: "job-synthetic-1",
      attempt: 0,
      attempts: 1,
    });
    expect(logs[0].costMicroUsdEst).toBe(550);
    expect(logs[0].reservedMicroUsd).toBe(17000);
    expect(logs[0].expireAt).toBe(NOW + resolvePolicy().aiCallLogRetentionDays * 86_400_000);
    expect(logs[1].userIdAtCall).toBeNull();
  });

  it("records the retry attempt index on the one logical-call log", async () => {
    let attempts = 0;
    const { ports, logs } = setup({
      async nameElements() {
        attempts += 1;
        return attempts === 1 ? { status: "failed", errorCode: "http_429", httpStatus: 429 } : READY;
      },
    });
    await ports.elementNamer.nameElements(namerInput());
    expect(logs).toMatchObject([{ attempt: 1, attempts: 2, outcome: "ok" }]);
  });

  it("logs a denied_* record for scene + chips denials too (all operations)", async () => {
    const composer: SceneComposer = {
      async composeScene(input) {
        return { status: "ready", value: { imageBase64: "x", promptVersion: input.promptVersion } };
      },
    };
    const suggester: ChipSuggester = {
      async suggestChips(input) {
        return { status: "ready", value: { chips: ["x"], promptVersion: input.promptVersion } };
      },
    };
    const { ports, logs } = setup(
      { async nameElements() { return READY; } },
      { composer, suggester, policy: resolvePolicy({ dailyBudgetUsd: 0 }) },
    );
    await ports.sceneComposer!.composeScene({
      elements: [], prompt: "s", size: "1024x1536", store: false,
      timeoutMs: 1, promptVersion: "scene.v1", labelMaxChars: DEFAULT_POLICY.elementLabelMaxChars,
      boardId: "b1", participantId: "p1", sceneId: "scene-1", jobId: "scene-1",
    });
    await ports.chipSuggester!.suggestChips({
      labels: ["x"], maxChips: 1, maxChipChars: 10, maxTokens: 1,
      timeoutMs: 1, promptVersion: "chips.v1", boardId: "b1", participantId: "p1",
    });
    await ports.segmenter.segment({
      imageRef: "x", prompt: { kind: "concept", concept: "mug" },
      timeoutMs: 1, boardId: "b1", participantId: "p1", photoId: "job-9", jobId: "job-9",
    });
    expect(logs.map((l) => [l.operation, l.outcome])).toEqual([
      ["composeScene", "denied_off"],
      ["suggestChips", "denied_off"],
      ["segment", "denied_off"],
    ]);
    expect(logs[0]).toMatchObject({ sceneId: "scene-1", jobId: "scene-1", participantId: "p1" });
    expect(logs[2]).toMatchObject({ photoId: "job-9", jobId: "job-9" });
  });
});
