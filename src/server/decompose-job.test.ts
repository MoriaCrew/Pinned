import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { emptyBoardCounters, type DecomposeJob } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import type { SamSegment } from "../gateway/model-gateway";
import type {
  ElementNamer,
  NamedElement,
  PortOutcome,
  SegmentInput,
  Segmenter,
} from "../gateway/ports";
import { resolvePolicy, type Policy, type PolicyOverrides } from "../policy/policy";
import { InMemoryDerivativeStore } from "./derivative-store";
import { processPhoto } from "./photo-intake";
import {
  InMemoryDecomposeJobStore,
  buildBoardWorkingRef,
  decomposeBoundMs,
  isUsableMask,
  runDecomposeJob,
  selectUsableSegment,
  startDecomposeJob,
  validateNamedElements,
  type DecomposeDeps,
} from "./decompose-job";
import type { DecodedSegment } from "./sam-mask";

// Verbatim example record from Meta's public SAM docs (see
// sam-mask.test.ts): a real decodable lossless mask, box
// 211,228..270,254 on a 320x334 frame, ~1.4% frame coverage.
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

const MUG: NamedElement = {
  label: "Teal Mug",
  concept: "teal mug",
  description: "distressed turquoise glaze",
  faceFlag: false,
};
const DUCK: NamedElement = {
  label: "Rubber Duck",
  concept: "rubber duck",
  description: "yellow duck in sunglasses",
  faceFlag: false,
};
const PERSON: NamedElement = {
  label: "Person",
  concept: "person smiling",
  description: "person holding a mug",
  faceFlag: true,
};

async function photoBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 320, height: 334, channels: 3, background: { r: 80, g: 120, b: 140 } },
  })
    .png()
    .toBuffer();
}

type SegBehavior =
  | { kind: "ready" }
  | { kind: "empty" }
  | { kind: "failed" }
  | { kind: "refused" }
  | { kind: "denied"; errorCode: string }
  | { kind: "gated"; gate: Promise<void> };

interface Harness {
  deps: DecomposeDeps;
  boards: InMemoryBoardRepository;
  jobs: InMemoryDecomposeJobStore;
  store: InMemoryDerivativeStore;
  calls: { namer: number; segmenter: string[] };
  /** Every SegmentInput the Segmenter received (PIN-213 wire checks). */
  segmentInputs: SegmentInput[];
}

async function makeHarness(opts: {
  elements?: NamedElement[];
  namerOutcome?: PortOutcome<{ elements: NamedElement[]; promptVersion: string }>;
  segmentByConcept?: Record<string, SegBehavior>;
  policyOverrides?: PolicyOverrides;
} = {}): Promise<Harness> {
  const boards = new InMemoryBoardRepository();
  await boards.createBoard({
    slug: "board-1",
    title: "Test board",
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
  const calls = { namer: 0, segmenter: [] as string[] };
  const segmentInputs: SegmentInput[] = [];
  const policy: Policy = resolvePolicy(opts.policyOverrides ?? null);

  const namer: ElementNamer = {
    async nameElements(input) {
      calls.namer += 1;
      if (opts.namerOutcome) return opts.namerOutcome;
      return {
        status: "ready",
        value: {
          elements: opts.elements ?? [MUG, DUCK],
          promptVersion: input.promptVersion,
        },
      };
    },
  };
  const segmenter: Segmenter = {
    async segment(input) {
      const concept =
        input.prompt.kind === "concept" ? input.prompt.concept : "(non-concept)";
      calls.segmenter.push(concept);
      segmentInputs.push(input);
      const behavior = opts.segmentByConcept?.[concept] ?? { kind: "ready" as const };
      if (behavior.kind === "gated") await behavior.gate;
      if (behavior.kind === "failed") {
        return { status: "failed", errorCode: "http_500", httpStatus: 500 };
      }
      if (behavior.kind === "refused") {
        return { status: "refused", errorCode: "content_policy" };
      }
      if (behavior.kind === "denied") {
        return { status: "failed", errorCode: behavior.errorCode };
      }
      if (behavior.kind === "empty") return { status: "ready", value: { segments: [] } };
      return { status: "ready", value: { segments: [DOCS_SEGMENT] } };
    },
  };

  let seq = 0;
  return {
    boards,
    jobs,
    store,
    calls,
    segmentInputs,
    deps: {
      boards,
      jobs,
      store,
      namer,
      segmenter,
      policy,
      now: () => 1000,
      newId: () => `job-${++seq}`,
    },
  };
}

describe("validators vs Policy (PIN-64)", () => {
  it("caps element count and concept words at the Policy values, dedupes", () => {
    const policy = resolvePolicy({
      elementsPerPhoto: { max: 2 },
      conceptMaxWords: 2,
    });
    const out = validateNamedElements(
      [
        { label: "A", concept: "Big Red Alarm Clock", description: "d", faceFlag: true },
        { label: "B", concept: "big red", description: "dup after truncation", faceFlag: false },
        { label: "C", concept: "teal mug", description: "d", faceFlag: false },
        { label: "D", concept: "extra thing", description: "over cap", faceFlag: false },
      ],
      policy,
    );
    expect(out.map((e) => e.concept)).toEqual(["big red", "teal mug"]);
    expect(out[0].faceFlag).toBe(true);
    // PIN-155: the service re-caps labels at the Policy value too.
    const [lamp] = validateNamedElements(
      [{ label: "Brass Desk Lamp", concept: "lamp", description: "d", faceFlag: false }],
      resolvePolicy({ elementLabelMaxChars: 5 }),
    );
    expect(lamp.label).toBe("Brass");
  });

  it("usable-mask window is the PIN-50 0.5%-60% by default and Policy-driven", () => {
    const policy = resolvePolicy(null);
    expect(isUsableMask(0.0049, policy)).toBe(false);
    expect(isUsableMask(0.005, policy)).toBe(true);
    expect(isUsableMask(0.6, policy)).toBe(true);
    expect(isUsableMask(0.61, policy)).toBe(false);
    const tighter = resolvePolicy({ usableMaskFrameFraction: { max: 0.1 } });
    expect(isUsableMask(0.2, tighter)).toBe(false);
  });
});

describe("startDecomposeJob happy path", () => {
  it("creates candidate pins + element assets and never stores the original", async () => {
    const h = await makeHarness();
    const original = await photoBytes();
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: original },
      h.deps,
    );

    expect(job.status).toBe("ready");
    expect(job.promptVersion).toBe("elements.v1");
    expect(job.elementIds).toHaveLength(2);
    expect(job.pinIds).toHaveLength(2);
    expect(job.failedConceptCount).toBe(0);
    expect(h.calls.namer).toBe(1);
    expect(h.calls.segmenter.sort()).toEqual(["rubber duck", "teal mug"]);

    // Privacy: the stored working copy is the stripped derivative
    // (WebP re-encode under tmp/), never the uploaded PNG bytes.
    expect(job.workingRef).toBe(buildBoardWorkingRef("board-1", job.id));
    expect(job.workingRef.startsWith("tmp/")).toBe(true);
    const working = await h.store.get(job.workingRef);
    expect(working).not.toBeNull();
    expect(Buffer.compare(working as Buffer, original)).not.toBe(0);
    expect((await sharp(working as Buffer).metadata()).format).toBe("webp");

    const elements = await h.boards.listElements("board-1");
    expect(elements).toHaveLength(2);
    for (const element of elements) {
      expect(element.ownerId).toBe("p1");
      expect(element.sourcePhotoId).toBe(job.id);
      expect(element.cutoutRef.startsWith("elements/")).toBe(true);
      expect(element.flattenedRef.startsWith("elements/")).toBe(true);
      const cutout = await h.store.get(element.cutoutRef);
      const flattened = await h.store.get(element.flattenedRef);
      expect((await sharp(cutout as Buffer).metadata()).format).toBe("png");
      expect((await sharp(flattened as Buffer).metadata()).format).toBe("jpeg");
      for (const v of Object.values(element.maskBox)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(element.maskBox.x2).toBeGreaterThan(element.maskBox.x1);
    }

    const pins = await h.boards.listPins("board-1", "candidate");
    expect(pins).toHaveLength(2);
    expect(pins.every((p) => p.pinnedBy === "p1")).toBe(true);

    const events = await h.boards.listEvents("board-1");
    expect(events.filter((e) => e.type === "element_added")).toHaveLength(2);
    expect(events.filter((e) => e.type === "pin_added")).toHaveLength(0);
    const board = await h.boards.getBoard("board-1");
    expect(board?.counters).toMatchObject({ elementCount: 2, pinCount: 0 });
  });

  it("rejects a missing board/participant before storing anything", async () => {
    const h = await makeHarness();
    await expect(
      startDecomposeJob(
        { boardId: "nope", participantId: "p1", bytes: await photoBytes() },
        h.deps,
      ),
    ).rejects.toThrow(RangeError);
    expect(await h.store.get(buildBoardWorkingRef("nope", "job-1"))).toBeNull();
    expect(h.calls.namer).toBe(0);
  });
});

describe("SAM store flag from Policy samStore (PIN-213)", () => {
  async function run(policyOverrides?: PolicyOverrides) {
    const h = await makeHarness(policyOverrides ? { policyOverrides } : {});
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      h.deps,
    );
    expect(job.status).toBe("ready");
    return h.segmentInputs;
  }

  it("default Policy sends no store key on any concept call", async () => {
    const inputs = await run();
    expect(inputs).toHaveLength(2);
    for (const input of inputs) expect(Object.keys(input)).not.toContain("store");
  });

  it("a per-board samStore:false reaches every concept call", async () => {
    const inputs = await run({ samStore: false });
    expect(inputs).toHaveLength(2);
    for (const input of inputs) expect(input.store).toBe(false);
  });
});

describe("idempotency and claim-before-call", () => {
  async function makePendingJob(h: Harness): Promise<DecomposeJob> {
    const processed = await processPhoto(await photoBytes());
    const workingRef = buildBoardWorkingRef("board-1", "job-x");
    await h.store.put(workingRef, processed.derivative, processed.contentType);
    const job: DecomposeJob = {
      id: "job-x",
      boardId: "board-1",
      participantId: "p1",
      status: "pending",
      workingRef,
      promptVersion: "elements.v1",
      elementIds: [],
      pinIds: [],
      faceNote: false,
      failedConceptCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    await h.jobs.create(job);
    return job;
  }

  it("a re-run of a finished job makes no port calls and no duplicates", async () => {
    const h = await makeHarness();
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      h.deps,
    );
    expect(job.status).toBe("ready");

    const again = await runDecomposeJob(job.id, h.deps);
    expect(again.status).toBe("ready");
    expect(h.calls.namer).toBe(1);
    expect(h.calls.segmenter).toHaveLength(2);
    expect(await h.boards.listElements("board-1")).toHaveLength(2);
    expect(await h.boards.listPins("board-1")).toHaveLength(2);
  });

  it("two concurrent runs: only the claim winner calls the ports", async () => {
    const h = await makeHarness();
    await makePendingJob(h);
    const [a, b] = await Promise.all([
      runDecomposeJob("job-x", h.deps),
      runDecomposeJob("job-x", h.deps),
    ]);
    expect([a.status, b.status].sort()).toEqual(["ready", "running"]);
    expect(h.calls.namer).toBe(1);
    expect(h.calls.segmenter).toHaveLength(2);
    expect(await h.boards.listElements("board-1")).toHaveLength(2);
    expect((await h.jobs.get("job-x"))?.status).toBe("ready");
  });

  it("throws RangeError for a missing job", async () => {
    const h = await makeHarness();
    await expect(runDecomposeJob("missing", h.deps)).rejects.toThrow(RangeError);
  });
});

describe("incremental candidate pins (pop-in)", () => {
  it("persists each pin as its SAM call lands, before slower ones finish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await makeHarness({
      segmentByConcept: { "rubber duck": { kind: "gated", gate } },
    });
    const running = startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      h.deps,
    );

    let earlyPins = 0;
    for (let i = 0; i < 200 && earlyPins === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      earlyPins = (await h.boards.listPins("board-1", "candidate")).length;
    }
    expect(earlyPins).toBe(1);
    expect((await h.jobs.get("job-1"))?.status).toBe("running");
    expect((await h.jobs.get("job-1"))?.pinIds).toHaveLength(1);

    release();
    const job = await running;
    expect(job.status).toBe("ready");
    expect(job.pinIds).toHaveLength(2);
  });
});

describe("partial failures and terminal states", () => {
  it("partial SAM failure keeps the good pins and still finishes ready", async () => {
    const h = await makeHarness({
      elements: [MUG, DUCK, PERSON],
      segmentByConcept: {
        "rubber duck": { kind: "failed" },
        "person smiling": { kind: "empty" },
      },
    });
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      h.deps,
    );
    expect(job.status).toBe("ready");
    expect(job.pinIds).toHaveLength(1);
    expect(job.failedConceptCount).toBe(2);
    const elements = await h.boards.listElements("board-1");
    expect(elements.map((e) => e.label)).toEqual(["Teal Mug"]);
  });

  it("no usable mask under the Policy window fails the job with no pins", async () => {
    const h = await makeHarness({
      policyOverrides: { usableMaskFrameFraction: { min: 0.5 } },
    });
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      h.deps,
    );
    expect(job).toMatchObject({ status: "failed", errorCode: "no_usable_pins" });
    expect(await h.boards.listPins("board-1")).toHaveLength(0);
  });

  it("a namer refusal becomes job refused, never a throw, with no SAM calls", async () => {
    const h = await makeHarness({
      namerOutcome: { status: "refused", errorCode: "content_policy" },
    });
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      h.deps,
    );
    expect(job).toMatchObject({ status: "refused", errorCode: "content_policy" });
    expect(h.calls.segmenter).toHaveLength(0);
    expect(await h.boards.listElements("board-1")).toHaveLength(0);
  });

  it("zero named elements fails as no_elements", async () => {
    const h = await makeHarness({ elements: [] });
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      h.deps,
    );
    expect(job).toMatchObject({ status: "failed", errorCode: "no_elements" });
  });
});

describe("AI budget denials surface as the job's errorCode (PIN-180)", () => {
  it("a namer the budget, call limit or AI switch denied fails with that code, no SAM calls", async () => {
    for (const errorCode of ["budget", "call_limit", "budget_off"]) {
      const h = await makeHarness({ namerOutcome: { status: "failed", errorCode } });
      const job = await startDecomposeJob(
        { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
        h.deps,
      );
      expect(job).toMatchObject({ status: "failed", errorCode });
      expect(h.calls.segmenter).toHaveLength(0);
    }
  });

  it("a segmenter the budget denied for every concept fails with the budget code, not no_usable_pins", async () => {
    const h = await makeHarness({
      segmentByConcept: {
        "teal mug": { kind: "denied", errorCode: "budget" },
        "rubber duck": { kind: "denied", errorCode: "budget" },
      },
    });
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      h.deps,
    );
    expect(job).toMatchObject({ status: "failed", errorCode: "budget", failedConceptCount: 2 });
    expect(job.pinIds).toHaveLength(0);
  });

  it("a denial after some pins landed still finishes ready with those pins", async () => {
    const h = await makeHarness({
      segmentByConcept: { "rubber duck": { kind: "denied", errorCode: "call_limit" } },
    });
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      h.deps,
    );
    expect(job.status).toBe("ready");
    expect(job.errorCode).toBeUndefined();
    expect(job.pinIds).toHaveLength(1);
  });

  it("a per-photo or per-person cap is not a budget denial", async () => {
    const h = await makeHarness({
      segmentByConcept: {
        "teal mug": { kind: "denied", errorCode: "photo_cap" },
        "rubber duck": { kind: "denied", errorCode: "participant_cap" },
      },
    });
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      h.deps,
    );
    expect(job).toMatchObject({ status: "failed", errorCode: "no_usable_pins" });
  });
});

describe("faces Policy", () => {
  it("faces=note (default): face sets the note flag and is never blocked", async () => {
    const h = await makeHarness({ elements: [PERSON, MUG] });
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      h.deps,
    );
    expect(job.status).toBe("ready");
    expect(job.faceNote).toBe(true);
    expect(job.pinIds).toHaveLength(2);
    const person = (await h.boards.listElements("board-1")).find(
      (e) => e.label === "Person",
    );
    expect(person?.faceFlag).toBe(true);
  });

  it("faces=allow: no note flag, pin still lands", async () => {
    const h = await makeHarness({
      elements: [PERSON],
      policyOverrides: { faces: "allow" },
    });
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      h.deps,
    );
    expect(job.faceNote).toBe(false);
    expect(job.pinIds).toHaveLength(1);
  });

  it("faces=block: face elements are dropped before any SAM spend", async () => {
    const h = await makeHarness({
      elements: [PERSON, MUG],
      policyOverrides: { faces: "block" },
    });
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      h.deps,
    );
    expect(job.status).toBe("ready");
    expect(job.faceNote).toBe(false);
    expect(h.calls.segmenter).toEqual(["teal mug"]);
    expect((await h.boards.listElements("board-1")).map((e) => e.label)).toEqual([
      "Teal Mug",
    ]);
  });
});

describe("board deleted mid-run (PIN-167)", () => {
  it("the job ends quietly and nothing lands on the dead board", async () => {
    const h = await makeHarness();
    const { namer } = h.deps;
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes() },
      {
        ...h.deps,
        namer: {
          async nameElements(input) {
            await h.boards.deleteBoard("board-1", 1_000);
            return namer.nameElements(input);
          },
        },
      },
    );
    expect(job).toMatchObject({ status: "failed", errorCode: "no_usable_pins", elementIds: [], pinIds: [] });
    expect(await h.boards.listElements("board-1")).toEqual([]);
    expect(await h.boards.listPins("board-1")).toEqual([]);
    expect((await h.boards.listEvents("board-1")).map((e) => e.type)).toEqual(["participant_joined"]);
  });
});

describe("deterministic upload id (idempotent start)", () => {
  const UPLOAD_ID = "11111111-2222-4333-8444-555555555555";

  it("a second start with the same jobId replays: existing job, no port calls, no duplicates", async () => {
    const h = await makeHarness();
    const first = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes(), jobId: UPLOAD_ID },
      h.deps,
    );
    expect(first.id).toBe(UPLOAD_ID);
    expect(first.status).toBe("ready");
    expect(first.replayed).toBeUndefined();

    const second = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes(), jobId: UPLOAD_ID },
      h.deps,
    );
    expect(second.replayed).toBe(true);
    expect(second.status).toBe("ready");
    expect(h.calls.namer).toBe(1);
    expect(h.calls.segmenter).toHaveLength(2);
    expect(await h.boards.listElements("board-1")).toHaveLength(2);
  });

  it("a failed working-copy write leaves no orphaned job and a same-id retry succeeds (Bugbot #146)", async () => {
    const h = await makeHarness();
    class FlakyWorkingStore extends InMemoryDerivativeStore {
      private thrown = false;
      async put(ref: string, bytes: Uint8Array, contentType: string): Promise<void> {
        if (ref.endsWith("working.webp") && !this.thrown) {
          this.thrown = true;
          throw new Error("transient storage failure");
        }
        return super.put(ref, bytes, contentType);
      }
    }
    const deps = { ...h.deps, store: new FlakyWorkingStore() };
    await expect(
      startDecomposeJob(
        { boardId: "board-1", participantId: "p1", bytes: await photoBytes(), jobId: UPLOAD_ID },
        deps,
      ),
    ).rejects.toThrow("transient storage failure");
    // No orphaned job at all: the failed start cleaned up after
    // itself, so nothing counts against the daily photo cap.
    expect(await h.jobs.get(UPLOAD_ID)).toBeNull();
    expect(h.calls.namer).toBe(0);

    const recovered = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes(), jobId: UPLOAD_ID },
      deps,
    );
    expect(recovered.replayed).toBeUndefined();
    expect(recovered.status).toBe("ready");
    expect(await h.boards.listElements("board-1")).toHaveLength(2);
  });

  it("a failed working-copy write never deletes a job a concurrent retry already claimed (Bugbot #146)", async () => {
    const h = await makeHarness();
    class ClaimingFailingStore extends InMemoryDerivativeStore {
      async put(ref: string, bytes: Uint8Array, contentType: string): Promise<void> {
        if (ref.endsWith("working.webp")) {
          // A same-id retry claimed the job while this write was
          // in flight; the write then reports failure.
          await h.jobs.claim(UPLOAD_ID, 9_999);
          throw new Error("ambiguous storage failure");
        }
        return super.put(ref, bytes, contentType);
      }
    }
    const deps = { ...h.deps, store: new ClaimingFailingStore() };
    await expect(
      startDecomposeJob(
        { boardId: "board-1", participantId: "p1", bytes: await photoBytes(), jobId: UPLOAD_ID },
        deps,
      ),
    ).rejects.toThrow("ambiguous storage failure");
    // The claimed job survives the failed start's cleanup.
    expect((await h.jobs.get(UPLOAD_ID))?.status).toBe("running");
  });

  it("job-store update is compare-and-set on the expected status", async () => {
    const h = await makeHarness();
    const job = await startDecomposeJob(
      { boardId: "board-1", participantId: "p1", bytes: await photoBytes(), jobId: UPLOAD_ID },
      h.deps,
    );
    // A blind `running` progress write must not resurrect the ready job.
    const lost = await h.jobs.update({ ...job, status: "running" }, "running");
    expect(lost).toBe(false);
    expect((await h.jobs.get(job.id))?.status).toBe("ready");
    const won = await h.jobs.update({ ...job, faceNote: true }, "ready");
    expect(won).toBe(true);
    expect((await h.jobs.get(job.id))?.faceNote).toBe(true);
    // No expected status: unconditional replace, resolving true.
    expect(await h.jobs.update({ ...job, faceNote: false })).toBe(true);
  });

  it("decomposeBoundMs sums Policy timeouts over attempts and SAM waves", () => {
    // Defaults: namer 2 x 30s + 0.5s backoff; SAM ceil(6/4)=2 waves of 2 x 20s + 0.5s.
    expect(decomposeBoundMs(resolvePolicy(null))).toBe(60_500 + 81_000);
    expect(
      decomposeBoundMs(resolvePolicy({ retries: 0, samConcurrency: 6 })),
    ).toBe(30_000 + 20_000);
  });

  it("selectUsableSegment: confidence first, size tiebreak, floor and no-confidence fallback", () => {
    const seg = (id: string, maskPixels: number, confidence?: number): DecodedSegment => ({
      id,
      box: { x1: 0, y1: 0, x2: 9, y2: 9 },
      ...(confidence !== undefined ? { confidence } : {}),
      raster: new Uint8Array(0),
      maskWidth: 10,
      maskHeight: 10,
      maskPixels,
      coverageFrame: 0.05,
      coverageBox: 0.5,
    });
    const policy = resolvePolicy(null);
    // Higher confidence beats a larger mask.
    expect(selectUsableSegment([seg("big", 900, 0.4), seg("sure", 100, 0.9)], policy)?.id).toBe("sure");
    // Equal confidence: larger wins.
    expect(selectUsableSegment([seg("a", 100, 0.9), seg("b", 200, 0.9)], policy)?.id).toBe("b");
    // No confidence anywhere (mock): largest-first, as before.
    expect(selectUsableSegment([seg("a", 100), seg("b", 200)], policy)?.id).toBe("b");
    // The Policy floor drops below-floor candidates.
    const floored = resolvePolicy({ samMinConfidence: 0.5 });
    expect(selectUsableSegment([seg("a", 900, 0.4)], floored)).toBeUndefined();
    expect(selectUsableSegment([seg("a", 900, 0.4), seg("b", 10)], floored)?.id).toBe("b");
  });
});
