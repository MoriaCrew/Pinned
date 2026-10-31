import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { emptyBoardCounters, type DecomposeJob, type Element, type SceneJob } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { InMemoryCreditLedgerStore } from "../domain/credit-ledger";
import {
  mockChipSuggester,
  mockElementNamer,
  mockSegmenter,
  MOCK_SCENE_PNG_BASE64,
} from "../gateway/mock-ports";
import type { ElementNamer, SceneComposer, Segmenter } from "../gateway/ports";
import { resolvePolicy, type Policy, type PolicyOverrides } from "../policy/policy";
import {
  confirmPins,
  createBoard,
  getBoardView,
  getJobView,
  getSceneChips,
  requestScene,
  tapAddPin,
  uploadPhoto,
  type BoardApiDeps,
} from "./board-api";
import { joinBoard, type BoardSessionDeps } from "./board-session";
import {
  CREDITS_POOL_EMPTY,
  ensureStarterMakes,
  photoDebitEventId,
  sceneDebitEventId,
  starterEventId,
} from "./credit-pool";
import { InMemoryDecomposeJobStore, runDecomposeJob } from "./decompose-job";
import { InMemoryDerivativeStore } from "./derivative-store";
import {
  InMemorySceneJobStore,
  buildSceneImageRef,
  runSceneJob,
  type SceneJobDeps,
} from "./scene-job";

const SECRET = "test-secret-test-secret-test-secret-32";
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);


async function photoBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 320, height: 334, channels: 3, background: { r: 80, g: 120, b: 140 } },
  })
    .png()
    .toBuffer();
}

type ComposerBehavior = "ready" | "refused" | "failed" | "budget";

interface Harness {
  api: BoardApiDeps;
  sceneDeps: SceneJobDeps;
  session: BoardSessionDeps;
  boards: InMemoryBoardRepository;
  jobs: InMemoryDecomposeJobStore;
  sceneJobs: InMemorySceneJobStore;
  store: InMemoryDerivativeStore;
  ledger: InMemoryCreditLedgerStore;
  policy: Policy;
  namerCalls: number;
  composerCalls: number;
  setComposer(b: ComposerBehavior): void;
  /** Swap the segmenter (photo-race drain) before a job runs. */
  setSegmenter(s: Segmenter): void;
  /** Swap the namer (photo-failure case) before a job runs. */
  setNamer(n: ElementNamer): void;
}

function makeHarness(
  overrides: PolicyOverrides = {},
  opts: { collageMode?: boolean; composer?: SceneComposer } = {},
): Harness {
  const boards = new InMemoryBoardRepository();
  const jobs = new InMemoryDecomposeJobStore();
  const sceneJobs = new InMemorySceneJobStore();
  const store = new InMemoryDerivativeStore();
  const ledger = new InMemoryCreditLedgerStore();
  const policy = resolvePolicy(overrides);
  const counters = { namer: 0, composer: 0 };
  let behavior: ComposerBehavior = "ready";
  let segmenter: Segmenter = mockSegmenter;
  let namerImpl: ElementNamer = mockElementNamer;

  const namer: ElementNamer = {
    async nameElements(input) {
      counters.namer += 1;
      return namerImpl.nameElements(input);
    },
  };
  const seg: Segmenter = {
    async segment(input) {
      return segmenter.segment(input);
    },
  };
  const composer: SceneComposer = opts.composer ?? {
    async composeScene(input) {
      counters.composer += 1;
      if (behavior === "refused") return { status: "refused", errorCode: "no_image" };
      if (behavior === "failed") return { status: "failed", errorCode: "http_500", httpStatus: 500 };
      if (behavior === "budget") return { status: "failed", errorCode: "budget" };
      return {
        status: "ready",
        value: { imageBase64: MOCK_SCENE_PNG_BASE64, promptVersion: input.promptVersion },
      };
    },
  };
  let seq = 0;
  const now = () => T0;
  const newId = () => `job-${++seq}`;
  const api: BoardApiDeps = {
    boards,
    jobs,
    store,
    namer,
    segmenter: seg,
    sceneJobs,
    composer,
    chipSuggester: mockChipSuggester,
    collageMode: opts.collageMode ?? false,
    credits: ledger,
    policy,
    now,
    newId,
  };
  const sceneDeps: SceneJobDeps = {
    boards,
    jobs: sceneJobs,
    store,
    composer,
    collageMode: opts.collageMode ?? false,
    credits: ledger,
    policy,
    now,
    newId,
  };
  return {
    api,
    sceneDeps,
    session: { boards, sessionSecret: SECRET, policy, now },
    boards,
    jobs,
    sceneJobs,
    store,
    ledger,
    policy,
    get namerCalls() {
      return counters.namer;
    },
    get composerCalls() {
      return counters.composer;
    },
    setComposer(b) {
      behavior = b;
    },
    setSegmenter(s) {
      segmenter = s;
    },
    setNamer(n) {
      namerImpl = n;
    },
  };
}

const ENABLED = (starterMakes: number): PolicyOverrides => ({
  credits: { enabled: true, starterMakes },
});

async function boardWithOwner(h: Harness) {
  const board = await createBoard({ title: "Pool board" }, h.api);
  const owner = await joinBoard(board.slug, { displayName: "Robin" }, null, h.session);
  return { slug: board.slug, owner: owner.participant };
}

/** Seed one pinned element directly (scene tests), like scene-job.test. */
async function seedSceneBoard(h: Harness, slug = "board-1") {
  await h.boards.createBoard({
    slug,
    title: "Scene board",
    counters: emptyBoardCounters(),
    createdAt: 1,
    version: 1,
  });
  await h.boards.putParticipant({
    id: "p1",
    boardId: slug,
    displayName: "Robin",
    cookieSecretHash: "hash",
    createdAt: 1,
  });
  const element: Element = {
    id: "el1",
    boardId: slug,
    ownerId: "p1",
    label: "Thing 1",
    description: "distinctive thing 1",
    maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
    cutoutRef: `elements/boards/${slug}/el1/cutout.png`,
    flattenedRef: `elements/boards/${slug}/el1/flattened.jpg`,
    sourcePhotoId: "photo-1",
    faceFlag: false,
    createdAt: 1,
  };
  // Sharp-produced so the collage lane can decode it (the 1x1 mock
  // composer PNG is header-only, as scene-job.test notes).
  const cutout = await sharp({
    create: { width: 30, height: 20, channels: 4, background: { r: 20, g: 160, b: 200, alpha: 1 } },
  })
    .png()
    .toBuffer();
  await h.store.put(element.cutoutRef, cutout, "image/png");
  await h.store.put(element.flattenedRef, Buffer.from("flat-1"), "image/jpeg");
  await h.boards.createElement(element);
  await h.boards.createPin({
    id: "pin1",
    boardId: slug,
    elementId: "el1",
    pinnedBy: "p1",
    status: "pinned",
    createdAt: 1,
  });
  const participant = await h.boards.getParticipant(slug, "p1");
  return { slug, participant: participant! };
}

async function entriesOf(h: Harness, slug: string) {
  return h.ledger.listEntries(slug);
}

describe("credits disabled (shipped default, PIN-151)", () => {
  it("writes nothing to the ledger across create, photo, scene and board view", async () => {
    const h = makeHarness();
    expect(h.policy.credits.enabled).toBe(false);
    const { slug, owner } = await boardWithOwner(h);

    const job = await uploadPhoto(slug, owner, await photoBytes(), h.api);
    expect(job.status).toBe("ready");
    await confirmPins(slug, owner, { jobId: job.id, pinIds: [job.pinIds[0]] }, h.api);
    const { scene } = await requestScene(
      slug,
      owner,
      { elementIds: [job.elementIds[0]], prompt: "on a picnic blanket" },
      h.api,
    );
    expect(scene.status).toBe("ready");
    expect(scene.kind).toBe("ai");

    const view = await getBoardView(slug, owner, h.api);
    expect(view).not.toHaveProperty("credits");
    expect(await h.ledger.getAccount(slug)).toBeNull();
    expect(await entriesOf(h, slug)).toEqual([]);
  });
});

describe("starter grant (PIN-151)", () => {
  it("grants exactly once at creation and exposes only availableMakes in the view", async () => {
    const h = makeHarness(ENABLED(3));
    const { slug, owner } = await boardWithOwner(h);

    expect(await h.ledger.getBalance(slug)).toMatchObject({ available: 3 });
    const entries = await entriesOf(h, slug);
    expect(entries.map((e) => [e.id, e.type, e.amount])).toEqual([
      [starterEventId(slug), "starter_grant", 3],
    ]);

    for (let i = 0; i < 2; i += 1) {
      const view = await getBoardView(slug, owner, h.api);
      expect(view?.credits).toEqual({ availableMakes: 3 });
    }
    await ensureStarterMakes(slug, h.api);
    expect(await entriesOf(h, slug)).toHaveLength(1);
  });

  it("grants lazily on the first balance read for a pre-existing board", async () => {
    const h = makeHarness(ENABLED(5));
    await h.boards.createBoard({
      slug: "old-board",
      title: "Old board",
      counters: emptyBoardCounters(),
      createdAt: 1,
      version: 1,
    });
    expect(await h.ledger.getAccount("old-board")).toBeNull();

    const view = await getBoardView("old-board", null, h.api);
    expect(view?.credits).toEqual({ availableMakes: 5 });
    expect((await entriesOf(h, "old-board")).map((e) => e.id)).toEqual([
      starterEventId("old-board"),
    ]);
  });
});

describe("cheap balance read (PIN-179)", () => {
  it("board polls on a granted board read the head only: no starter grant call", async () => {
    const h = makeHarness(ENABLED(3));
    const { slug, owner } = await boardWithOwner(h);
    const grant = vi.spyOn(h.ledger, "grantStarter");
    const reads = vi.spyOn(h.ledger, "getBalance");
    for (let i = 0; i < 3; i += 1) {
      expect((await getBoardView(slug, owner, h.api))?.credits).toEqual({ availableMakes: 3 });
    }
    expect(grant).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledTimes(3);
  });

  it("concurrent first touches on a pre-existing board grant the starter exactly once", async () => {
    const h = makeHarness(ENABLED(5));
    await h.boards.createBoard({
      slug: "old-board",
      title: "Old board",
      counters: emptyBoardCounters(),
      createdAt: 1,
      version: 1,
    });
    const views = await Promise.all(
      Array.from({ length: 4 }, () => getBoardView("old-board", null, h.api)),
    );
    expect(views.map((v) => v?.credits)).toEqual(Array(4).fill({ availableMakes: 5 }));
    expect((await entriesOf(h, "old-board")).map((e) => e.id)).toEqual([
      starterEventId("old-board"),
    ]);

    const grant = vi.spyOn(h.ledger, "grantStarter");
    await getBoardView("old-board", null, h.api);
    expect(grant).not.toHaveBeenCalled();
  });

  it("photo preflight, photo debit and an AI scene on a granted board never call the starter grant", async () => {
    const h = makeHarness(ENABLED(3));
    const { slug, owner } = await boardWithOwner(h);
    const grant = vi.spyOn(h.ledger, "grantStarter");

    const job = await uploadPhoto(slug, owner, await photoBytes(), h.api);
    expect(job.status).toBe("ready");
    await confirmPins(slug, owner, { jobId: job.id, pinIds: [job.pinIds[0]] }, h.api);
    const { scene } = await requestScene(
      slug,
      owner,
      { elementIds: [job.elementIds[0]], prompt: "on a picnic blanket" },
      h.api,
    );
    expect(scene.kind).toBe("ai");

    expect(grant).not.toHaveBeenCalled();
    expect((await h.ledger.getBalance(slug)).available).toBe(1);
  });

  it("credits disabled: board polls make no ledger call at all", async () => {
    const h = makeHarness();
    const { slug, owner } = await boardWithOwner(h);
    const spies = [
      vi.spyOn(h.ledger, "getBalance"),
      vi.spyOn(h.ledger, "getAccount"),
      vi.spyOn(h.ledger, "grantStarter"),
      vi.spyOn(h.ledger, "debit"),
    ];
    const view = await getBoardView(slug, owner, h.api);
    expect(view).not.toHaveProperty("credits");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("photo debit (PIN-151)", () => {
  it("debits exactly 1 for a completed photo regardless of element count; replay and riders never debit", async () => {
    const h = makeHarness(ENABLED(3));
    const { slug, owner } = await boardWithOwner(h);

    const job = await uploadPhoto(slug, owner, await photoBytes(), h.api);
    expect(job.status).toBe("ready");
    expect(job.pinIds.length).toBe(3); // three mock elements, still one make
    expect((await h.ledger.getBalance(slug)).available).toBe(2);
    expect((await entriesOf(h, slug)).map((e) => e.id)).toEqual([
      starterEventId(slug),
      photoDebitEventId(job.id),
    ]);

    // Replay of the finished job: no second port run, no second debit.
    const again = await runDecomposeJob(job.id, {
      boards: h.boards,
      jobs: h.jobs,
      store: h.store,
      namer: h.api.namer,
      segmenter: h.api.segmenter,
      credits: h.ledger,
      policy: h.policy,
      now: () => T0,
    });
    expect(again.status).toBe("ready");

    // Riders: a tap-add on the same job and generated chips stay free.
    const tapped = await tapAddPin(slug, owner, job.id, { x: 0.5, y: 0.5 }, h.api);
    expect(tapped.pin.id).toBeTruthy();
    await confirmPins(slug, owner, { jobId: job.id, pinIds: [job.pinIds[0]] }, h.api);
    const chips = await getSceneChips(slug, owner, { elementIds: [job.elementIds[0]] }, h.api);
    expect(chips.chips.length).toBeGreaterThan(0);

    expect((await h.ledger.getBalance(slug)).available).toBe(2);
    expect((await entriesOf(h, slug)).filter((e) => e.type === "debit")).toHaveLength(1);
  });

  it("lazily grants the starter on a pre-existing board's first make, then debits it", async () => {
    const h = makeHarness(ENABLED(2));
    await h.boards.createBoard({
      slug: "old-board",
      title: "Old board",
      counters: emptyBoardCounters(),
      createdAt: 1,
      version: 1,
    });
    const joined = await joinBoard("old-board", { displayName: "Robin" }, null, h.session);
    const job = await uploadPhoto("old-board", joined.participant, await photoBytes(), h.api);
    expect(job.status).toBe("ready");
    expect((await entriesOf(h, "old-board")).map((e) => e.type)).toEqual([
      "starter_grant",
      "debit",
    ]);
    expect((await h.ledger.getBalance("old-board")).available).toBe(1);
  });

  it("a lost-response replay with the same uploadId never double-debits", async () => {
    const h = makeHarness(ENABLED(3));
    const { slug, owner } = await boardWithOwner(h);
    const UPLOAD_ID = "11111111-2222-4333-8444-555555555555";
    const first = await uploadPhoto(slug, owner, await photoBytes(), h.api, UPLOAD_ID);
    expect(first.status).toBe("ready");
    expect((await h.ledger.getBalance(slug)).available).toBe(2);

    const replay = await uploadPhoto(slug, owner, await photoBytes(), h.api, UPLOAD_ID);
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(UPLOAD_ID);
    expect((await h.ledger.getBalance(slug)).available).toBe(2);
    expect((await entriesOf(h, slug)).filter((e) => e.type === "debit")).toHaveLength(1);
  });

  it("never debits a failed photo", async () => {
    const h = makeHarness(ENABLED(3));
    h.setNamer({
      async nameElements() {
        return { status: "failed", errorCode: "http_500", httpStatus: 500 };
      },
    });
    const { slug, owner } = await boardWithOwner(h);
    const job = await uploadPhoto(slug, owner, await photoBytes(), h.api);
    expect(job.status).toBe("failed");
    expect((await h.ledger.getBalance(slug)).available).toBe(3);
    expect((await entriesOf(h, slug)).filter((e) => e.type === "debit")).toEqual([]);
  });

  it("pool-empty refuses the photo before intake or any AI call (429 credits_pool_empty)", async () => {
    const h = makeHarness(ENABLED(0));
    const { slug, owner } = await boardWithOwner(h);
    await expect(uploadPhoto(slug, owner, await photoBytes(), h.api)).rejects.toMatchObject({
      name: "BoardApiError",
      status: 429,
      code: CREDITS_POOL_EMPTY,
    });
    expect(h.namerCalls).toBe(0);
    expect(await h.jobs.listForBoard(slug)).toEqual([]);
    expect((await entriesOf(h, slug)).map((e) => e.type)).toEqual(["starter_grant"]);
  });

  it("concurrent drain of the last make: the photo fails pool-empty and its pins are discarded", async () => {
    const h = makeHarness(ENABLED(1));
    const { slug, owner } = await boardWithOwner(h);
    let drained = false;
    h.setSegmenter({
      async segment(input) {
        if (!drained) {
          drained = true;
          // Another make lands while this photo is mid-run.
          await h.ledger.debit(slug, { eventId: "drain:other-make", amount: 1, at: T0 });
        }
        return mockSegmenter.segment(input);
      },
    });
    const job = await uploadPhoto(slug, owner, await photoBytes(), h.api);
    expect(job.status).toBe("failed");
    expect(job.errorCode).toBe(CREDITS_POOL_EMPTY);
    expect(job.pinIds).toEqual([]);
    expect(await h.boards.listPins(slug)).toEqual([]);
    expect(await h.boards.listElements(slug)).toEqual([]);
    const view = await getJobView(slug, job.id, owner, h.api);
    expect(view?.pins).toEqual([]);
    expect((await h.ledger.getBalance(slug)).available).toBe(0);
    expect((await entriesOf(h, slug)).filter((e) => e.type === "debit").map((e) => e.id)).toEqual([
      "drain:other-make",
    ]);
  });
});

describe("scene debit (PIN-151)", () => {
  it("debits exactly 1 for a ready AI scene; replay never re-debits or re-composes", async () => {
    const h = makeHarness(ENABLED(2));
    const { slug, participant } = await seedSceneBoard(h);
    const { job, scene } = await requestScene(
      slug,
      participant,
      { elementIds: ["el1"], prompt: "on a picnic blanket" },
      h.api,
    );
    expect(scene.status).toBe("ready");
    expect(scene.kind).toBe("ai");
    expect((await h.ledger.getBalance(slug)).available).toBe(1);
    expect((await entriesOf(h, slug)).map((e) => e.id)).toEqual([
      starterEventId(slug),
      sceneDebitEventId(job.id),
    ]);

    const calls = h.composerCalls;
    const again = await runSceneJob(slug, job.id, h.sceneDeps);
    expect(again.status).toBe("ready");
    expect(h.composerCalls).toBe(calls);
    expect((await entriesOf(h, slug)).filter((e) => e.type === "debit")).toHaveLength(1);
  });

  it("never debits refused or failed AI scenes", async () => {
    for (const behavior of ["refused", "failed"] as const) {
      const h = makeHarness(ENABLED(2));
      h.setComposer(behavior);
      const { slug, participant } = await seedSceneBoard(h);
      const { scene } = await requestScene(
        slug,
        participant,
        { elementIds: ["el1"], prompt: "on a picnic blanket" },
        h.api,
      );
      expect(scene.status).toBe(behavior);
      expect((await h.ledger.getBalance(slug)).available).toBe(2);
      expect((await entriesOf(h, slug)).filter((e) => e.type === "debit")).toEqual([]);
    }
  });

  it("never debits collage output: budget fallback and mock collage mode", async () => {
    const budget = makeHarness(ENABLED(2));
    budget.setComposer("budget");
    const a = await seedSceneBoard(budget);
    const fallback = await requestScene(
      a.slug,
      a.participant,
      { elementIds: ["el1"], prompt: "on a picnic blanket" },
      budget.api,
    );
    expect(fallback.scene.status).toBe("ready");
    expect(fallback.scene.kind).toBe("collage");
    expect(fallback.scene.collageReason).toBe("budget"); // PIN-180: nothing was debited, and it says why
    expect((await budget.ledger.getBalance(a.slug)).available).toBe(2);

    const mock = makeHarness(ENABLED(2), { collageMode: true });
    const b = await seedSceneBoard(mock);
    const collaged = await requestScene(
      b.slug,
      b.participant,
      { elementIds: ["el1"], prompt: "on a picnic blanket" },
      mock.api,
    );
    expect(collaged.scene.status).toBe("ready");
    expect(collaged.scene.kind).toBe("collage");
    expect(collaged.scene.collageReason).toBe("mock");
    expect(mock.composerCalls).toBe(0);
    // The mock collage is not a credit touch at all: no starter, no debit.
    expect(await mock.ledger.getAccount(b.slug)).toBeNull();
    expect(await entriesOf(mock, b.slug)).toEqual([]);
  });

  it("pool-empty takes the free collage lane pre-spend; daily caps still apply", async () => {
    const h = makeHarness({ ...ENABLED(0), scenesPerBoardPerDay: 1 });
    const { slug, participant } = await seedSceneBoard(h);
    const { scene } = await requestScene(
      slug,
      participant,
      { elementIds: ["el1"], prompt: "on a picnic blanket" },
      h.api,
    );
    expect(scene.status).toBe("ready");
    expect(scene.kind).toBe("collage");
    expect(scene.collageReason).toBe("pool_empty");
    expect(h.composerCalls).toBe(0);
    expect((await entriesOf(h, slug)).filter((e) => e.type === "debit")).toEqual([]);

    await expect(
      requestScene(slug, participant, { elementIds: ["el1"], prompt: "again" }, h.api),
    ).rejects.toMatchObject({ status: 429, code: "scenes_per_board_day" });
  });

  it("concurrent last-make race cannot expose two AI scenes", async () => {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrierComposer: SceneComposer = {
      async composeScene(input) {
        arrived += 1;
        if (arrived === 2) release();
        await gate;
        return {
          status: "ready",
          value: { imageBase64: MOCK_SCENE_PNG_BASE64, promptVersion: input.promptVersion },
        };
      },
    };
    const h = makeHarness(ENABLED(1), { composer: barrierComposer });
    const { slug } = await seedSceneBoard(h);
    const pending = (id: string): SceneJob => ({
      id,
      boardId: slug,
      participantId: "p1",
      elementIds: ["el1"],
      prompt: "on a picnic blanket",
      status: "pending",
      promptVersion: "scene.v1",
      createdAt: T0,
      updatedAt: T0,
    });
    await h.sceneJobs.create(pending("race-a"));
    await h.sceneJobs.create(pending("race-b"));

    const [a, b] = await Promise.all([
      runSceneJob(slug, "race-a", h.sceneDeps),
      runSceneJob(slug, "race-b", h.sceneDeps),
    ]);
    // Both passed the pool preflight and composed; only one debit lands.
    expect(arrived).toBe(2);
    const winners = [a, b].filter((j) => j.status === "ready" && j.kind === "ai");
    const losers = [a, b].filter((j) => j.status === "failed");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].errorCode).toBe(CREDITS_POOL_EMPTY);

    const winnerScene = await h.boards.getScene(winners[0].id);
    expect(winnerScene?.status).toBe("ready");
    const loserScene = await h.boards.getScene(losers[0].id);
    expect(loserScene?.status).toBe("failed");
    expect(loserScene?.imageRef).toBeUndefined();
    expect(await h.store.get(buildSceneImageRef(slug, losers[0].id, "png"))).toBeNull();

    expect((await h.ledger.getBalance(slug)).available).toBe(0);
    expect((await entriesOf(h, slug)).filter((e) => e.type === "debit").map((e) => e.id)).toEqual([
      sceneDebitEventId(winners[0].id),
    ]);
  });
});

describe("kill flag off mid-life (PIN-151)", () => {
  it("returns to pre-credit behaviour: empty pool no longer blocks, nothing more writes", async () => {
    const h = makeHarness(ENABLED(1));
    const { slug, owner } = await boardWithOwner(h);
    const first = await uploadPhoto(slug, owner, await photoBytes(), h.api);
    expect(first.status).toBe("ready");
    expect((await h.ledger.getBalance(slug)).available).toBe(0);
    const entriesBefore = await entriesOf(h, slug);

    const offPolicy = resolvePolicy({ credits: { starterMakes: 1 } }); // enabled unset = false
    const offApi: BoardApiDeps = { ...h.api, policy: offPolicy };
    const second = await uploadPhoto(slug, owner, await photoBytes(), offApi);
    expect(second.status).toBe("ready");
    expect(second.pinIds.length).toBeGreaterThan(0);

    await confirmPins(slug, owner, { jobId: second.id, pinIds: [second.pinIds[0]] }, offApi);
    const { scene } = await requestScene(
      slug,
      owner,
      { elementIds: [second.elementIds[0]], prompt: "on a picnic blanket" },
      offApi,
    );
    expect(scene.status).toBe("ready");
    expect(scene.kind).toBe("ai"); // not the pool-empty collage lane while off

    const view = await getBoardView(slug, owner, offApi);
    expect(view).not.toHaveProperty("credits");
    expect(await entriesOf(h, slug)).toEqual(entriesBefore);
  });
});

describe("paid make survives a failed terminal write (PIN-151)", () => {
  class FlakyReadyPhotoStore extends InMemoryDecomposeJobStore {
    private thrown = false;
    async update(job: DecomposeJob): Promise<void> {
      if (job.status === "ready" && !this.thrown) {
        this.thrown = true;
        throw new Error("transient write failure");
      }
      return super.update(job);
    }
  }

  class FlakyReadySceneStore extends InMemorySceneJobStore {
    private thrown = false;
    async update(job: SceneJob): Promise<void> {
      if (job.status === "ready" && !this.thrown) {
        this.thrown = true;
        throw new Error("transient write failure");
      }
      return super.update(job);
    }
  }

  it("photo: the ready write retries, candidates stay, exactly one debit", async () => {
    const h = makeHarness(ENABLED(2));
    const { slug, owner } = await boardWithOwner(h);
    const api: BoardApiDeps = { ...h.api, jobs: new FlakyReadyPhotoStore() };
    const job = await uploadPhoto(slug, owner, await photoBytes(), api);
    expect(job.status).toBe("ready");
    expect(job.pinIds.length).toBeGreaterThan(0);
    expect((await h.boards.listElements(slug)).length).toBeGreaterThan(0);
    expect((await h.ledger.getBalance(slug)).available).toBe(1);
    expect((await entriesOf(h, slug)).filter((e) => e.type === "debit")).toHaveLength(1);
  });

  it("scene: the ready write retries, the paid AI scene stays ready", async () => {
    const h = makeHarness(ENABLED(2));
    const { slug, participant } = await seedSceneBoard(h);
    const api: BoardApiDeps = { ...h.api, sceneJobs: new FlakyReadySceneStore() };
    const { job, scene } = await requestScene(
      slug,
      participant,
      { elementIds: ["el1"], prompt: "on a picnic blanket" },
      api,
    );
    expect(scene.status).toBe("ready");
    expect(scene.kind).toBe("ai");
    expect(await h.store.get(buildSceneImageRef(slug, job.id, "png"))).not.toBeNull();
    expect((await h.ledger.getBalance(slug)).available).toBe(1);
    expect((await entriesOf(h, slug)).filter((e) => e.type === "debit")).toHaveLength(1);
  });
});
