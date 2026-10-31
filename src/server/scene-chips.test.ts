import { describe, expect, it, vi } from "vitest";
import type { Participant } from "../domain/board";
import { emptyBoardCounters } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { chipsCacheKey } from "../domain/chips";
import type { ChipSuggester, PortOutcome, SuggestChipsInput } from "../gateway/ports";
import { resolvePolicy, type Policy } from "../policy/policy";
import { BoardApiError } from "./board-session";
import { InMemoryChipsCacheStore } from "./chips-cache";
import { resolveSceneChips, type SceneChipsDeps } from "./scene-chips";

// PIN-214: a stand-in German catalog (never edit de.json by hand) so
// the fallback's language is visible before the translate run.
const DE_CHIPS = vi.hoisted(() => ({
  "make.chip.picnic": "auf einer sonnigen Picknickdecke",
  "make.chip.museum": "in einem winzigen Museum",
  "make.chip.space": "schwebend im Weltall",
  "make.chip.party": "auf einer Geburtstagsparty",
}));
vi.mock("../i18n/messages/de.json", () => ({ default: DE_CHIPS }));

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
const GENERATED = ["sharing a tiny espresso bar", "napping in a sunbeam"];
const EN_FIXED = [
  "on a sunny picnic blanket",
  "in a tiny museum",
  "floating in space",
  "at a birthday party",
];

function participant(boardId: string): Participant {
  return {
    id: "p1",
    boardId,
    displayName: "Robin",
    cookieSecretHash: "x",
    createdAt: T0,
  };
}

/** Seed one board with pinned elements; returns their ids in order. */
async function seedBoard(
  boards: InMemoryBoardRepository,
  slug: string,
  labels: string[],
): Promise<string[]> {
  await boards.createBoard({
    slug,
    title: "Chips board",
    counters: emptyBoardCounters(),
    createdAt: T0,
    version: 1,
  });
  const elementIds: string[] = [];
  for (const [i, label] of labels.entries()) {
    const elementId = `${slug}-e${i}`;
    await boards.createElement({
      id: elementId,
      boardId: slug,
      ownerId: "p1",
      label,
      description: label,
      maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
      cutoutRef: `elements/${elementId}.png`,
      flattenedRef: `elements/${elementId}.jpg`,
      sourcePhotoId: "photo-1",
      faceFlag: false,
      createdAt: T0,
    });
    await boards.createPin({
      id: `${elementId}-pin`,
      boardId: slug,
      elementId,
      pinnedBy: "p1",
      status: "pinned",
      createdAt: T0,
    });
    elementIds.push(elementId);
  }
  return elementIds;
}

type ChipsOutcome = PortOutcome<{ chips: string[]; promptVersion: string }>;

function fakeSuggester(outcome: ChipsOutcome) {
  const inputs: SuggestChipsInput[] = [];
  const suggester: ChipSuggester = {
    async suggestChips(input) {
      inputs.push(input);
      return outcome;
    },
  };
  return { suggester, inputs };
}

async function setup(
  outcome: ChipsOutcome = {
    status: "ready",
    value: { chips: [...GENERATED], promptVersion: "chips.v2" },
  },
  policy: Policy = resolvePolicy(),
) {
  const boards = new InMemoryBoardRepository();
  const elementIds = await seedBoard(boards, "board-1", ["Teal Mug", "Orange Tabby Cat"]);
  const { suggester, inputs } = fakeSuggester(outcome);
  const cache = new InMemoryChipsCacheStore();
  let now = T0;
  const deps: SceneChipsDeps = {
    boards,
    suggester,
    cache,
    policy,
    now: () => now,
  };
  return {
    boards,
    elementIds,
    inputs,
    cache,
    deps,
    policy,
    me: participant("board-1"),
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("resolveSceneChips (PIN-75)", () => {
  it("generates once with Policy limits, then serves the cache with zero model calls", async () => {
    const ctx = await setup();
    const first = await resolveSceneChips("board-1", ctx.me, { elementIds: ctx.elementIds }, ctx.deps, "en");
    expect(first).toEqual({ chips: GENERATED, source: "generated" });
    expect(ctx.inputs).toHaveLength(1);
    expect(ctx.inputs[0]).toMatchObject({
      labels: ["Teal Mug", "Orange Tabby Cat"],
      locale: "en",
      maxChips: ctx.policy.chipsMax,
      maxChipChars: ctx.policy.scenePromptMaxChars,
      maxTokens: ctx.policy.maxTokens.sparkChips,
      timeoutMs: ctx.policy.timeoutsMs.spark,
      promptVersion: "chips.v2",
      boardId: "board-1",
      participantId: "p1",
    });

    const second = await resolveSceneChips("board-1", ctx.me, { elementIds: [...ctx.elementIds].reverse() }, ctx.deps, "en");
    expect(second).toEqual({ chips: GENERATED, source: "cache" });
    expect(ctx.inputs).toHaveLength(1);
  });

  it("key normalization: same labels in another order/case on another board hit the same entry", async () => {
    const ctx = await setup();
    await resolveSceneChips("board-1", ctx.me, { elementIds: ctx.elementIds }, ctx.deps, "en");
    const otherIds = await seedBoard(ctx.boards, "board-2", ["orange tabby cat", " TEAL  MUG "]);
    const out = await resolveSceneChips(
      "board-2",
      participant("board-2"),
      { elementIds: otherIds },
      ctx.deps,
      "en",
    );
    expect(out).toEqual({ chips: GENERATED, source: "cache" });
    expect(ctx.inputs).toHaveLength(1);
  });

  it("regenerates after Policy.chipsCacheTtlHours", async () => {
    const ctx = await setup(undefined, resolvePolicy({ chipsCacheTtlHours: 1 }));
    await resolveSceneChips("board-1", ctx.me, { elementIds: ctx.elementIds }, ctx.deps, "en");
    ctx.setNow(T0 + 60 * 60 * 1000 - 1);
    expect(
      (await resolveSceneChips("board-1", ctx.me, { elementIds: ctx.elementIds }, ctx.deps, "en")).source,
    ).toBe("cache");
    ctx.setNow(T0 + 60 * 60 * 1000);
    expect(
      (await resolveSceneChips("board-1", ctx.me, { elementIds: ctx.elementIds }, ctx.deps, "en")).source,
    ).toBe("generated");
    expect(ctx.inputs).toHaveLength(2);
  });

  it.each([
    ["refused", { status: "refused", errorCode: "content_policy" } as ChipsOutcome],
    ["failed", { status: "failed", errorCode: "http_500", httpStatus: 500 } as ChipsOutcome],
    ["budget-denied", { status: "failed", errorCode: "budget_off" } as ChipsOutcome],
    ["empty ready", { status: "ready", value: { chips: [], promptVersion: "chips.v2" } } as ChipsOutcome],
  ])("falls back to the fixed idea chips on %s and caches nothing", async (_name, outcome) => {
    const ctx = await setup(outcome);
    const first = await resolveSceneChips("board-1", ctx.me, { elementIds: ctx.elementIds }, ctx.deps, "en");
    expect(first).toEqual({ chips: EN_FIXED, source: "fallback" });
    // Nothing cached: a later open retries generation.
    await resolveSceneChips("board-1", ctx.me, { elementIds: ctx.elementIds }, ctx.deps, "en");
    expect(ctx.inputs).toHaveLength(2);
  });

  it("no suggester wired = fixed-chip fallback, never an error", async () => {
    const ctx = await setup();
    const deps = { ...ctx.deps, suggester: undefined };
    const out = await resolveSceneChips("board-1", ctx.me, { elementIds: ctx.elementIds }, deps, "en");
    expect(out).toEqual({ chips: EN_FIXED, source: "fallback" });
  });

  it("validates board, picks and pinned elements with the uniform API errors", async () => {
    const ctx = await setup();
    await expect(
      resolveSceneChips("nope", ctx.me, { elementIds: ctx.elementIds }, ctx.deps, "en"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      resolveSceneChips("board-1", ctx.me, { elementIds: [] }, ctx.deps, "en"),
    ).rejects.toBeInstanceOf(BoardApiError);
    await expect(
      resolveSceneChips("board-1", ctx.me, { elementIds: ["foreign"] }, ctx.deps, "en"),
    ).rejects.toMatchObject({ status: 404 });
    expect(ctx.inputs).toHaveLength(0);
  });
});

describe("resolveSceneChips in the viewer's language (PIN-214)", () => {
  it("asks the port in the request's language and caches per language", async () => {
    const ctx = await setup();
    const picks = { elementIds: ctx.elementIds };
    expect((await resolveSceneChips("board-1", ctx.me, picks, ctx.deps, "fr")).source).toBe("generated");
    expect((await resolveSceneChips("board-1", ctx.me, picks, ctx.deps, "de")).source).toBe("generated");
    expect(ctx.inputs.map((input) => input.locale)).toEqual(["fr", "de"]);
    // Same picks, same language: the cache answers, no third call.
    expect((await resolveSceneChips("board-1", ctx.me, picks, ctx.deps, "fr")).source).toBe("cache");
    expect(ctx.inputs).toHaveLength(2);

    const labels = ["Teal Mug", "Orange Tabby Cat"];
    const stored = await ctx.cache.get(chipsCacheKey(labels, { locale: "de", promptVersion: "chips.v2" }));
    expect(stored).toMatchObject({ chips: GENERATED, locale: "de", promptVersion: "chips.v2" });
  });

  it("a new prompt version never serves the old version's chips", async () => {
    const ctx = await setup();
    const picks = { elementIds: ctx.elementIds };
    await resolveSceneChips("board-1", ctx.me, picks, ctx.deps, "fr");
    const v3 = resolvePolicy({ promptVersions: { chips: "chips.v3" } });
    const out = await resolveSceneChips("board-1", ctx.me, picks, { ...ctx.deps, policy: v3 }, "fr");
    expect(out.source).toBe("generated");
    expect(ctx.inputs.map((input) => input.promptVersion)).toEqual(["chips.v2", "chips.v3"]);
  });

  it("falls back to the fixed idea chips in the request's language, Policy count of them", async () => {
    const ctx = await setup({ status: "refused", errorCode: "content_policy" });
    const out = await resolveSceneChips("board-1", ctx.me, { elementIds: ctx.elementIds }, ctx.deps, "de");
    expect(out).toEqual({ chips: Object.values(DE_CHIPS), source: "fallback" });

    const two = { ...ctx.deps, suggester: undefined, policy: resolvePolicy({ sceneChipsCount: 2 }) };
    expect(await resolveSceneChips("board-1", ctx.me, { elementIds: ctx.elementIds }, two, "de")).toEqual({
      chips: [DE_CHIPS["make.chip.picnic"], DE_CHIPS["make.chip.museum"]],
      source: "fallback",
    });
  });
});
