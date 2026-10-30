import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { emptyBoardCounters } from "../domain/board";
import type { AiCallLog } from "../domain/types";
import { InMemoryBoardRepository } from "../domain/board-repository";
import type { SamSegment } from "../gateway/model-gateway";
import { InMemoryBudgetStore, dayBucketFor } from "../gateway/budget";
import { decoratePorts } from "../gateway/decorators";
import { mockElementNamer, mockSegmenter } from "../gateway/mock-ports";
import type {
  ElementNamer,
  SegmentPrompt,
  Segmenter,
} from "../gateway/ports";
import { resolvePolicy, type PolicyOverrides } from "../policy/policy";
import {
  confirmPins,
  createBoard,
  getJobView,
  tapAddPin,
  uploadPhoto,
  type BoardApiDeps,
} from "./board-api";
import { joinBoard, type BoardSessionDeps } from "./board-session";
import {
  InMemoryDecomposeJobStore,
  addTapElement,
  startDecomposeJob,
  type DecomposeDeps,
} from "./decompose-job";
import { InMemoryDerivativeStore } from "./derivative-store";

// Real decodable SAM docs mask (see decompose-job.test.ts): box
// 211,228..270,254 on a 320x334 frame, ~1.4% coverage (usable).
const DOCS_SEGMENT: SamSegment = {
  id: "0",
  box: { x1: 211, y1: 228, x2: 270, y2: 254, w: 320, h: 334 },
  mask: {
    height: 27,
    width: 60,
    encoding: "~",
    payload: "!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(",
  },
};

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
const SECRET = "test-secret-test-secret-test-secret-32";

async function photoBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 320, height: 334, channels: 3, background: { r: 80, g: 120, b: 140 } },
  })
    .png()
    .toBuffer();
}

interface ServiceHarness {
  deps: DecomposeDeps;
  boards: InMemoryBoardRepository;
  jobs: InMemoryDecomposeJobStore;
  store: InMemoryDerivativeStore;
  prompts: SegmentPrompt[];
  segmenter: Segmenter;
  setNow(now: number): void;
}

async function makeServiceHarness(opts: {
  pointSegments?: SamSegment[];
  pointOutcome?: { status: "failed" | "refused"; errorCode?: string };
  policyOverrides?: PolicyOverrides;
} = {}): Promise<ServiceHarness> {
  const boards = new InMemoryBoardRepository();
  await boards.createBoard({
    slug: "board-1",
    title: "Tap board",
    counters: emptyBoardCounters(),
    createdAt: 1,
    version: 1,
  });
  await boards.putParticipant({
    id: "p1",
    boardId: "board-1",
    displayName: "Robin",
    cookieSecretHash: "hash",
    createdAt: 1,
  });
  const jobs = new InMemoryDecomposeJobStore();
  const store = new InMemoryDerivativeStore();
  const prompts: SegmentPrompt[] = [];
  let now = T0;
  const namer: ElementNamer = {
    async nameElements(input) {
      return {
        status: "ready",
        value: {
          elements: [
            { label: "Teal Mug", concept: "teal mug", description: "glaze", faceFlag: false },
          ],
          promptVersion: input.promptVersion,
        },
      };
    },
  };
  const segmenter: Segmenter = {
    async segment(input) {
      prompts.push(input.prompt);
      if (input.prompt.kind === "point" && opts.pointOutcome) return opts.pointOutcome;
      const segments =
        input.prompt.kind === "point" ? (opts.pointSegments ?? [DOCS_SEGMENT]) : [DOCS_SEGMENT];
      return { status: "ready", value: { segments } };
    },
  };
  let seq = 0;
  return {
    boards,
    jobs,
    store,
    prompts,
    segmenter,
    setNow(value: number) {
      now = value;
    },
    deps: {
      boards,
      jobs,
      store,
      namer,
      segmenter,
      policy: resolvePolicy(opts.policyOverrides ?? null),
      now: () => now,
      newId: () => `job-${++seq}`,
    },
  };
}

async function readyJob(h: ServiceHarness) {
  const job = await startDecomposeJob(
    { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
    h.deps,
  );
  expect(job.status).toBe("ready");
  expect(job.pinIds).toHaveLength(1);
  return job;
}

describe("addTapElement point -> pin (PIN-78)", () => {
  it("segments the tapped point, cuts out, and appends a candidate to the same job", async () => {
    const h = await makeServiceHarness();
    const job = await readyJob(h);

    const outcome = await addTapElement(job.id, { x: 0.25, y: 0.75 }, "My thing", h.deps);
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;

    // The Segmenter saw exactly one point prompt, normalized
    // point untouched, frame from the working copy.
    const pointPrompts = h.prompts.filter((p) => p.kind === "point");
    expect(pointPrompts).toEqual([
      {
        kind: "point",
        points: [{ x: 0.25, y: 0.75, label: "positive" }],
        frame: { width: 320, height: 334 },
      },
    ]);

    expect(outcome.element.label).toBe("My thing");
    expect(outcome.element.description).toBe("My thing");
    expect(outcome.element.ownerId).toBe("p1");
    expect(outcome.element.sourcePhotoId).toBe(job.id);
    expect(outcome.pin.status).toBe("candidate");
    expect(outcome.job.elementIds).toEqual([job.elementIds[0], outcome.element.id]);
    expect(outcome.job.pinIds).toEqual([job.pinIds[0], outcome.pin.id]);
    const cutout = await h.store.get(outcome.element.cutoutRef);
    const flattened = await h.store.get(outcome.element.flattenedRef);
    expect((await sharp(cutout as Buffer).metadata()).format).toBe("png");
    expect((await sharp(flattened as Buffer).metadata()).format).toBe("jpeg");
    // Working copy survives for more taps until confirm (A6a).
    expect(await h.store.get(job.workingRef)).not.toBeNull();
  });

  it("enforces elementsPerPhoto.max including tap-adds, before any SAM spend", async () => {
    const h = await makeServiceHarness({ policyOverrides: { elementsPerPhoto: { max: 1 } } });
    const job = await readyJob(h);
    const outcome = await addTapElement(job.id, { x: 0.5, y: 0.5 }, "My thing", h.deps);
    expect(outcome).toEqual({ status: "cap_reached" });
    expect(h.prompts.filter((p) => p.kind === "point")).toHaveLength(0);
    expect(await h.boards.listElements("board-1")).toHaveLength(1);
  });

  it("expired working copy is a friendly gone, deletes the object and spends nothing", async () => {
    const h = await makeServiceHarness();
    const job = await readyJob(h);
    h.setNow(T0 + 25 * 60 * 60 * 1000); // past the 24h Policy TTL
    const outcome = await addTapElement(job.id, { x: 0.5, y: 0.5 }, "My thing", h.deps);
    expect(outcome).toEqual({ status: "working_copy_gone" });
    expect(await h.store.get(job.workingRef)).toBeNull();
    expect((await h.jobs.get(job.id))?.workingDeletedAt).toBe(T0 + 25 * 60 * 60 * 1000);
    expect(h.prompts.filter((p) => p.kind === "point")).toHaveLength(0);
  });

  it("a missing working-copy object is working_copy_gone", async () => {
    const h = await makeServiceHarness();
    const job = await readyJob(h);
    await h.store.delete(job.workingRef);
    const outcome = await addTapElement(job.id, { x: 0.5, y: 0.5 }, "My thing", h.deps);
    expect(outcome).toEqual({ status: "working_copy_gone" });
    expect(h.prompts.filter((p) => p.kind === "point")).toHaveLength(0);
  });

  it("no usable mask at the tap adds nothing", async () => {
    const h = await makeServiceHarness({ pointSegments: [] });
    const job = await readyJob(h);
    const outcome = await addTapElement(job.id, { x: 0.5, y: 0.5 }, "My thing", h.deps);
    expect(outcome).toEqual({ status: "no_usable_mask" });
    expect(await h.boards.listElements("board-1")).toHaveLength(1);
    expect((await h.jobs.get(job.id))?.pinIds).toHaveLength(1);
  });

  it("a second tap also lands; ids stay unique", async () => {
    const h = await makeServiceHarness();
    const job = await readyJob(h);
    const first = await addTapElement(job.id, { x: 0.2, y: 0.2 }, "My thing", h.deps);
    const second = await addTapElement(job.id, { x: 0.8, y: 0.8 }, "My thing", h.deps);
    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") return;
    expect(first.element.id).not.toBe(second.element.id);
    expect(second.job.pinIds).toHaveLength(3);
  });

  it("segment-cap denials map to the friendly cap_reached stop (PIN-92)", async () => {
    for (const errorCode of ["participant_cap", "photo_cap"]) {
      const h = await makeServiceHarness({
        pointOutcome: { status: "failed", errorCode },
      });
      const job = await readyJob(h);
      const outcome = await addTapElement(job.id, { x: 0.5, y: 0.5 }, "My thing", h.deps);
      expect(outcome).toEqual({ status: "cap_reached" });
      expect(await h.boards.listElements("board-1")).toHaveLength(1);
    }
    // A provider refusal stays a typed refusal, never a cap or 500.
    const h = await makeServiceHarness({
      pointOutcome: { status: "refused", errorCode: "content_policy" },
    });
    const job = await readyJob(h);
    expect(await addTapElement(job.id, { x: 0.5, y: 0.5 }, "My thing", h.deps)).toEqual({
      status: "refused",
      errorCode: "content_policy",
    });
  });

  it("end to end: decorated per-photo cap bounds failing taps, concept call included (PIN-92)", async () => {
    // Every tap misses (no segments): without PIN-92 this loop
    // could burn SAM calls forever on one live working copy.
    const h = await makeServiceHarness({ pointSegments: [] });
    const budget = new InMemoryBudgetStore();
    const logs: AiCallLog[] = [];
    let logSeq = 0;
    const policy = resolvePolicy({ segmentsPerPhoto: 3 });
    const decorated = decoratePorts(
      { elementNamer: mockElementNamer, segmenter: h.segmenter },
      {
        policy,
        budget,
        appendLog: async (log) => {
          logs.push(log);
        },
        now: () => T0,
        sleep: async () => undefined,
        newId: () => `log-${++logSeq}`,
        onLogError: () => undefined,
      },
    );
    const deps: DecomposeDeps = { ...h.deps, segmenter: decorated.segmenter, policy };
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      deps,
    );
    expect(job.status).toBe("ready"); // 1 concept SAM call used 1 of 3
    expect(await addTapElement(job.id, { x: 0.5, y: 0.5 }, "My thing", deps)).toEqual({
      status: "no_usable_mask",
    });
    expect(await addTapElement(job.id, { x: 0.4, y: 0.4 }, "My thing", deps)).toEqual({
      status: "no_usable_mask",
    });
    // Photo budget (1 concept + 2 taps) is spent: the 3rd tap is
    // denied at reserve and never reaches SAM.
    expect(await addTapElement(job.id, { x: 0.3, y: 0.3 }, "My thing", deps)).toEqual({
      status: "cap_reached",
    });
    expect(h.prompts.filter((p) => p.kind === "point")).toHaveLength(2);
    expect(budget.snapshot(dayBucketFor(T0)).photos).toEqual({ [job.id]: 3 });
    expect(budget.snapshot(dayBucketFor(T0)).participantSegments).toEqual({ p1: 3 });
    // Every provider call (concept + both taps) has an AiCallLog.
    expect(logs.filter((l) => l.operation === "segment")).toHaveLength(3);
  });

  it("unknown job is not_found", async () => {
    const h = await makeServiceHarness();
    expect(await addTapElement("nope", { x: 0, y: 0 }, "My thing", h.deps)).toEqual({
      status: "not_found",
    });
  });
});

describe("tapAddPin API layer (PIN-78)", () => {
  async function makeApiHarness() {
    const boards = new InMemoryBoardRepository();
    const jobs = new InMemoryDecomposeJobStore();
    const store = new InMemoryDerivativeStore();
    const policy = resolvePolicy({});
    let seq = 0;
    const deps: BoardApiDeps = {
      boards,
      jobs,
      store,
      namer: mockElementNamer,
      segmenter: mockSegmenter,
      policy,
      now: () => T0,
      newId: () => `job-${++seq}`,
    };
    const session: BoardSessionDeps = { boards, sessionSecret: SECRET, policy, now: () => T0 };
    const board = await createBoard({ title: "Tap API" }, deps);
    const owner = (await joinBoard(board.slug, { displayName: "Robin" }, null, session)).participant;
    const other = (await joinBoard(board.slug, { displayName: "Aye" }, null, session)).participant;
    const job = await uploadPhoto(board.slug, owner, await photoBytes(), deps);
    expect(job.status).toBe("ready");
    return { deps, boards, slug: board.slug, owner, other, job };
  }

  it("owner tap lands a generic-labelled candidate confirmable with the rest", async () => {
    const { deps, slug, owner, job } = await makeApiHarness();
    const before = job.pinIds.length;
    const result = await tapAddPin(slug, owner, job.id, { x: 0.4, y: 0.6 }, deps);
    expect(result.element.label).toBe("My thing"); // i18n add.tapLabel
    expect(result.pin.status).toBe("candidate");
    expect(result.job.pinIds).toHaveLength(before + 1);
    expect(result.job.workingCopyGone).toBe(false);

    const view = await getJobView(slug, job.id, owner, deps);
    expect(view?.pins.map((p) => p.id)).toContain(result.pin.id);

    const confirmed = await confirmPins(
      slug,
      owner,
      { jobId: job.id, pinIds: [result.pin.id] },
      deps,
    );
    expect(confirmed.pinnedPinIds).toEqual([result.pin.id]);
    expect(confirmed.workingCopyDeleted).toBe(true);

    // Post-confirm the copy is gone: friendly 409, and the job
    // view flags it so the sheet hides the tap surface.
    await expect(tapAddPin(slug, owner, job.id, { x: 0.1, y: 0.1 }, deps)).rejects.toMatchObject({
      name: "BoardApiError",
      status: 409,
      code: "working_copy_gone",
    });
    const after = await getJobView(slug, job.id, owner, deps);
    expect(after?.job.workingCopyGone).toBe(true);
  });

  it("confirming without the tap pin drops it (no orphan candidate)", async () => {
    const { deps, boards, slug, owner, job } = await makeApiHarness();
    const tap = await tapAddPin(slug, owner, job.id, { x: 0.4, y: 0.6 }, deps);
    const confirmed = await confirmPins(
      slug,
      owner,
      { jobId: job.id, pinIds: [job.pinIds[0]] },
      deps,
    );
    expect(confirmed.droppedPinIds).toContain(tap.pin.id);
    expect(await boards.getPin(tap.pin.id)).toBeNull();
    expect(confirmed.workingCopyDeleted).toBe(true);
  });

  it("404s non-uploaders, anonymous callers and wrong boards; 400s bad points", async () => {
    const { deps, slug, owner, other, job } = await makeApiHarness();
    await expect(tapAddPin(slug, other, job.id, { x: 0.5, y: 0.5 }, deps)).rejects.toMatchObject({
      status: 404,
    });
    await expect(tapAddPin(slug, null, job.id, { x: 0.5, y: 0.5 }, deps)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      tapAddPin("other-board", owner, job.id, { x: 0.5, y: 0.5 }, deps),
    ).rejects.toMatchObject({ status: 404 });
    for (const bad of [{ x: -0.1, y: 0.5 }, { x: 0.5, y: 1.5 }, { x: "0.5", y: 0.5 }, {}, null]) {
      await expect(tapAddPin(slug, owner, job.id, bad, deps)).rejects.toMatchObject({
        status: 400,
      });
    }
  });
});
