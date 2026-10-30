import { describe, expect, it } from "vitest";
import {
  LABEL_EDGE_FRACTION,
  addSheetStage,
  applyOptimisticConfirm,
  canConfirmJob,
  canTapAdd,
  cuttingProgress,
  maskBoxOf,
  overlayRect,
  isAwaitingTapPin,
  normalizedTapPoint,
  confirmPayload,
  downscaleTarget,
  isTerminalJob,
  newCandidatePins,
  selectionWithCandidates,
  shouldShowFaceNote,
  spreadLabels,
  reviewHelp,
} from "./add-sheet";
import type { BoardViewLike } from "./board-view";

function view(): BoardViewLike {
  return {
    participants: [{ id: "me", displayName: "Robin" }],
    elements: [
      { id: "e1", ownerId: "me", label: "mug", faceFlag: false, imageUrl: "/e1" },
      { id: "e2", ownerId: "me", label: "cat", faceFlag: true, imageUrl: "/e2" },
    ],
    pins: [
      { id: "old", elementId: "e1", pinnedBy: "me", status: "pinned", createdAt: 1 },
      { id: "c2", elementId: "e2", pinnedBy: "me", status: "candidate", createdAt: 3 },
      { id: "c1", elementId: "e1", pinnedBy: "me", status: "candidate", createdAt: 2 },
      { id: "cOther", elementId: "e2", pinnedBy: "p2", status: "candidate", createdAt: 4 },
    ],
  };
}

describe("add sheet logic (PIN-67)", () => {
  it("downscales the longest side to the Policy cap and never upscales", () => {
    expect(downscaleTarget(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200, scaled: true });
    expect(downscaleTarget(800, 600, 1600)).toEqual({ width: 800, height: 600, scaled: false });
    expect(downscaleTarget(0, 600, 1600).scaled).toBe(false);
  });

  it("pops in only my new candidates, oldest first", () => {
    expect(newCandidatePins(view(), "me", new Set(["old"])).map((p) => p.id)).toEqual(["c1", "c2"]);
    expect(newCandidatePins(view(), "me", new Set(["old", "c1"])).map((p) => p.id)).toEqual(["c2"]);
  });

  it("pre-selects new candidates but keeps explicit drops dropped", () => {
    const first = selectionWithCandidates(new Set(), new Set(), ["c1"]);
    expect([...first]).toEqual(["c1"]);
    const second = selectionWithCandidates(first, new Set(["c1"]), ["c1", "c2"]);
    expect([...second].sort()).toEqual(["c2"]);
    const pruned = selectionWithCandidates(new Set(["gone"]), new Set(), ["c2"]);
    expect([...pruned]).toEqual(["c2"]);
  });

  it("builds the Pin N payload only with a job and a selection", () => {
    expect(confirmPayload("job1", new Set(["c1"]))).toEqual({ jobId: "job1", pinIds: ["c1"] });
    expect(confirmPayload("job1", new Set())).toBeNull();
    expect(confirmPayload("", new Set(["c1"]))).toBeNull();
  });

  it("optimistically pins the selected and removes the dropped", () => {
    const next = applyOptimisticConfirm(view(), ["c1", "c2"], new Set(["c2"]));
    expect(next.pins.map((p) => [p.id, p.status])).toEqual([
      ["old", "pinned"],
      ["c2", "pinned"],
      ["cOther", "candidate"],
    ]);
  });

  it("shows the face note once per photo and never for other jobs", () => {
    expect(shouldShowFaceNote(true, "job1", null)).toBe(true);
    expect(shouldShowFaceNote(true, "job1", "job1")).toBe(false);
    expect(shouldShowFaceNote(true, "job2", "job1")).toBe(true);
    expect(shouldShowFaceNote(false, "job1", null)).toBe(false);
    expect(shouldShowFaceNote(true, null, null)).toBe(false);
  });

  it("normalizes tap points against the preview box and rejects outsides (PIN-78)", () => {
    const rect = { left: 100, top: 200, width: 400, height: 200 };
    expect(normalizedTapPoint(100, 200, rect)).toEqual({ x: 0, y: 0 });
    expect(normalizedTapPoint(300, 300, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedTapPoint(500, 400, rect)).toEqual({ x: 1, y: 1 });
    expect(normalizedTapPoint(99, 300, rect)).toBeNull();
    expect(normalizedTapPoint(300, 401, rect)).toBeNull();
    expect(normalizedTapPoint(300, 300, { ...rect, width: 0 })).toBeNull();
  });

  it("shows tap-add only on a ready job with a live copy, preview and cap room (PIN-78)", () => {
    const base = {
      jobStatus: "ready" as const,
      workingCopyGone: false,
      hasPreview: true,
      elementCount: 3,
      maxElements: 6,
      busy: false,
    };
    expect(canTapAdd(base)).toBe(true);
    expect(canTapAdd({ ...base, jobStatus: "running" })).toBe(false);
    expect(canTapAdd({ ...base, jobStatus: null })).toBe(false);
    expect(canTapAdd({ ...base, workingCopyGone: true })).toBe(false);
    expect(canTapAdd({ ...base, hasPreview: false })).toBe(false);
    expect(canTapAdd({ ...base, elementCount: 6 })).toBe(false);
    expect(canTapAdd({ ...base, busy: true })).toBe(false);
  });

  it("waits only for the just-tapped pin on its own job (PIN-78)", () => {
    const pending = { pinId: "tap1", jobId: "job1", at: 100 };
    expect(isAwaitingTapPin(pending, "job1", ["c1"], 0)).toBe(true);
    expect(isAwaitingTapPin(pending, "job1", ["c1", "tap1"], 0)).toBe(false);
    expect(isAwaitingTapPin(null, "job1", ["c1"], 0)).toBe(false);
    // Previous photo's pending tap never gates the new job.
    expect(isAwaitingTapPin(pending, "job2", ["c9"], 0)).toBe(false);
    expect(isAwaitingTapPin(pending, null, ["c9"], 0)).toBe(false);
    // A refetch failure after the tap releases; a stale pre-tap
    // error does not.
    expect(isAwaitingTapPin(pending, "job1", ["c1"], 101)).toBe(false);
    expect(isAwaitingTapPin(pending, "job1", ["c1"], 99)).toBe(true);
  });

  it("treats ready/failed/refused as terminal", () => {
    expect(isTerminalJob("ready")).toBe(true);
    expect(isTerminalJob("refused")).toBe(true);
    expect(isTerminalJob("running")).toBe(false);
    expect(isTerminalJob("pending")).toBe(false);
  });
});

describe("cut-out moment (PIN-99)", () => {
  const base = { uploadPending: false, jobId: null, jobStatus: null, candidateCount: 0 } as const;

  it("starts at pick and goes back there after an upload error", () => {
    expect(addSheetStage(base)).toBe("pick");
  });

  it("is finding while the upload or job runs with nothing cut yet", () => {
    expect(addSheetStage({ ...base, uploadPending: true })).toBe("finding");
    expect(addSheetStage({ ...base, jobId: "job1" })).toBe("finding");
    expect(addSheetStage({ ...base, jobId: "job1", jobStatus: "running" })).toBe("finding");
    expect(addSheetStage({ ...base, jobId: "job1", jobStatus: "pending" })).toBe("finding");
  });

  it("is cutting once candidates pop in before the job is done", () => {
    expect(addSheetStage({ ...base, uploadPending: true, candidateCount: 2 })).toBe("cutting");
    expect(addSheetStage({ ...base, jobId: "job1", jobStatus: "running", candidateCount: 1 })).toBe("cutting");
  });

  it("reviews a ready job, even with nothing found (tap-to-add is the fix)", () => {
    expect(addSheetStage({ ...base, jobId: "job1", jobStatus: "ready", candidateCount: 3 })).toBe("review");
    expect(addSheetStage({ ...base, jobId: "job1", jobStatus: "ready", candidateCount: 0 })).toBe("review");
  });

  it("ends on failed or refused jobs", () => {
    expect(addSheetStage({ ...base, jobId: "job1", jobStatus: "failed" })).toBe("ended");
    expect(addSheetStage({ ...base, jobId: "job1", jobStatus: "refused", candidateCount: 2 })).toBe("ended");
  });

  it("reviews what landed before a job failed, so leftovers can still be pinned (PIN-122)", () => {
    expect(addSheetStage({ ...base, jobId: "job1", jobStatus: "failed", candidateCount: 2 })).toBe("review");
    expect(canConfirmJob("failed", 2)).toBe(true);
    expect(canConfirmJob("failed", 0)).toBe(false);
    expect(canConfirmJob("ready", 0)).toBe(true);
    expect(canConfirmJob("running", 2)).toBe(false);
    expect(canConfirmJob("refused", 2)).toBe(false);
    // Tap-to-add stays off: only a ready job takes taps.
    expect(
      canTapAdd({ jobStatus: "failed", workingCopyGone: false, hasPreview: true, elementCount: 2, maxElements: 8, busy: false }),
    ).toBe(false);
  });

  it("draws the newest candidate as cutting only while the job runs", () => {
    const pins = [
      { id: "a", createdAt: 1 },
      { id: "c", createdAt: 3 },
      { id: "b", createdAt: 2 },
    ];
    expect(cuttingProgress(pins, true)).toEqual({ cuttingId: "c", ready: 2 });
    expect(cuttingProgress(pins, false)).toEqual({ cuttingId: null, ready: 3 });
    expect(cuttingProgress([], true)).toEqual({ cuttingId: null, ready: 0 });
    expect(cuttingProgress([{ id: "a", createdAt: 1 }], true)).toEqual({ cuttingId: "a", ready: 0 });
    // Same timestamp: a stable tie-break on id.
    expect(cuttingProgress([{ id: "x", createdAt: 5 }, { id: "y", createdAt: 5 }], true).cuttingId).toBe("y");
  });

  it("places a sticker at its maskBox", () => {
    const rect = overlayRect({ x1: 0.5, y1: 0.5, x2: 0.75, y2: 0.8 });
    expect(rect).not.toBeNull();
    expect(rect!.left).toBeCloseTo(0.5);
    expect(rect!.top).toBeCloseTo(0.5);
    expect(rect!.width).toBeCloseTo(0.25);
    expect(rect!.height).toBeCloseTo(0.3);
    expect(rect!.label).toEqual({ x: 0.625, y: 0.5, below: false });
  });

  it("clamps boxes to the photo and fixes swapped corners", () => {
    const rect = overlayRect({ x1: 1.2, y1: 0.9, x2: 0.6, y2: -0.3 })!;
    expect(rect.left).toBeCloseTo(0.6);
    expect(rect.width).toBeCloseTo(0.4);
    expect(rect.top).toBeCloseTo(0);
    expect(rect.height).toBeCloseTo(0.9);
  });

  it("grows tiny boxes to the minimum size and keeps them inside", () => {
    const dot = overlayRect({ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }, 0.1)!;
    expect(dot.width).toBeCloseTo(0.1);
    expect(dot.height).toBeCloseTo(0.1);
    expect(dot.left).toBeCloseTo(0.45);
    expect(dot.top).toBeCloseTo(0.45);
    const corner = overlayRect({ x1: 0.99, y1: 0.99, x2: 1, y2: 1 }, 0.1)!;
    expect(corner.left).toBeCloseTo(0.9);
    expect(corner.top).toBeCloseTo(0.9);
    expect(corner.left + corner.width).toBeLessThanOrEqual(1);
    const origin = overlayRect({ x1: 0, y1: 0, x2: 0, y2: 0 }, 0.1)!;
    expect(origin.left).toBe(0);
    expect(origin.top).toBe(0);
  });

  it("keeps name labels inside the photo and flips them below near the top", () => {
    const right = overlayRect({ x1: 0.85, y1: 0.5, x2: 1, y2: 0.8 })!;
    expect(right.label.x).toBeCloseTo(1 - LABEL_EDGE_FRACTION);
    const left = overlayRect({ x1: 0, y1: 0.5, x2: 0.1, y2: 0.8 })!;
    expect(left.label.x).toBeCloseTo(LABEL_EDGE_FRACTION);
    const top = overlayRect({ x1: 0.2, y1: 0.02, x2: 0.4, y2: 0.3 })!;
    expect(top.label.below).toBe(true);
    expect(top.label.y).toBeCloseTo(0.3);
  });

  it("moves a label that would touch an earlier one to the other side", () => {
    const mug = overlayRect({ x1: 0.513, y1: 0.569, x2: 0.725, y2: 0.82 })!;
    const duck = overlayRect({ x1: 0.715, y1: 0.688, x2: 0.806, y2: 0.82 })!;
    const plant = overlayRect({ x1: 0.828, y1: 0.523, x2: 0.99, y2: 0.818 })!;
    const [a, b, c] = spreadLabels([mug, duck, plant]);
    expect(a).toBe(mug);
    // The duck's label sits a row lower than the mug's: no clash.
    expect(b).toBe(duck);
    // The plant's would sit on the mug's: it goes below the plant.
    expect(c.label).toEqual({ x: plant.label.x, y: plant.top + plant.height, below: true });
    expect(c.left).toBe(plant.left);
  });

  it("keeps a clashing label in place when the other side is taken too", () => {
    const one = overlayRect({ x1: 0.4, y1: 0.4, x2: 0.5, y2: 0.5 })!;
    const twin = overlayRect({ x1: 0.4, y1: 0.4, x2: 0.5, y2: 0.5 })!;
    const triplet = overlayRect({ x1: 0.4, y1: 0.4, x2: 0.5, y2: 0.5 })!;
    const [, second, third] = spreadLabels([one, twin, triplet]);
    expect(second.label.below).toBe(true);
    expect(third.label).toEqual(triplet.label);
    expect(spreadLabels([])).toEqual([]);
  });

  it("never flips a label up out of the photo", () => {
    // Boxes at the very top label below; a clash there stays below.
    const top = overlayRect({ x1: 0, y1: 0, x2: 0.25, y2: 0.34 })!;
    const twin = overlayRect({ x1: 0, y1: 0, x2: 0.25, y2: 0.34 })!;
    const [first, second] = spreadLabels([top, twin]);
    expect(first.label.below).toBe(true);
    expect(second.label).toEqual(twin.label);
  });

  it("returns null for missing or broken boxes", () => {
    expect(overlayRect(null)).toBeNull();
    expect(overlayRect(undefined)).toBeNull();
    expect(overlayRect({ x1: Number.NaN, y1: 0, x2: 1, y2: 1 })).toBeNull();
    expect(overlayRect({ x1: 0, y1: 0, x2: Number.POSITIVE_INFINITY, y2: 1 })).toBeNull();
  });

  it("reads maskBox off API elements and guards copies without one", () => {
    expect(maskBoxOf({ id: "e1", maskBox: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 } })).toEqual({
      x1: 0.1,
      y1: 0.2,
      x2: 0.3,
      y2: 0.4,
    });
    expect(maskBoxOf({ id: "e1" })).toBeNull();
    expect(maskBoxOf({ id: "e1", maskBox: null })).toBeNull();
    expect(maskBoxOf({ id: "e1", maskBox: { x1: "0", y1: 0, x2: 1, y2: 1 } })).toBeNull();
    expect(maskBoxOf(undefined)).toBeNull();
  });
});

describe("review help line (PIN-126)", () => {
  it("follows the selection: all kept, some left out, none kept", () => {
    expect(reviewHelp(3, 0)).toEqual({ kind: "allKept" });
    expect(reviewHelp(3, 1)).toEqual({ kind: "someLeftOut", n: 1 });
    expect(reviewHelp(3, 2)).toEqual({ kind: "someLeftOut", n: 2 });
    expect(reviewHelp(3, 3)).toEqual({ kind: "noneKept" });
    expect(reviewHelp(1, 1)).toEqual({ kind: "noneKept" });
  });
});
