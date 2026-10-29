import { describe, expect, it } from "vitest";
import {
  applyOptimisticConfirm,
  confirmPayload,
  downscaleTarget,
  isTerminalJob,
  newCandidatePins,
  selectionWithCandidates,
  shouldShowFaceNote,
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

  it("treats ready/failed/refused as terminal", () => {
    expect(isTerminalJob("ready")).toBe(true);
    expect(isTerminalJob("refused")).toBe(true);
    expect(isTerminalJob("running")).toBe(false);
    expect(isTerminalJob("pending")).toBe(false);
  });
});
