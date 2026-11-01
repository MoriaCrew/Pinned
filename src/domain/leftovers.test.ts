import { describe, expect, it } from "vitest";
import type { BoardViewPin } from "./board-view";
import { leftoversOf, withoutLeftovers } from "./leftovers";

const pin = (id: string, over: Partial<BoardViewPin> = {}): BoardViewPin => ({
  id,
  elementId: `el-${id}`,
  pinnedBy: "me",
  status: "candidate",
  createdAt: 10,
  ...over,
});

describe("leftovers (PIN-122)", () => {
  it("is empty without a viewer or without own candidates", () => {
    const view = { pins: [pin("a", { jobId: "j1" })] };
    expect(leftoversOf(view, null)).toEqual({ groups: [], count: 0 });
    expect(leftoversOf({ pins: [pin("a", { status: "pinned" })] }, "me")).toEqual({ groups: [], count: 0 });
  });

  it("groups own candidates by photo job, newest photo first, and counts them all", () => {
    const view = {
      pins: [
        pin("old-2", { jobId: "j-old", createdAt: 3 }),
        pin("old-1", { jobId: "j-old", createdAt: 2 }),
        pin("new-1", { jobId: "j-new", createdAt: 20 }),
        pin("new-2", { jobId: "j-new", createdAt: 21 }),
        pin("new-3", { jobId: "j-new", createdAt: 21 }),
      ],
    };
    const result = leftoversOf(view, "me");
    expect(result.count).toBe(5);
    expect(result.groups.map((g) => g.jobId)).toEqual(["j-new", "j-old"]);
    // Arrival order inside a photo (ties by id), elements alongside.
    expect(result.groups[0]).toEqual({
      jobId: "j-new",
      pinIds: ["new-1", "new-2", "new-3"],
      elementIds: ["el-new-1", "el-new-2", "el-new-3"],
      newestAt: 21,
    });
    expect(result.groups[1].pinIds).toEqual(["old-1", "old-2"]);
  });

  it("ignores pinned pins, other people's candidates and pins without a job", () => {
    const view = {
      pins: [
        pin("mine", { jobId: "j1" }),
        pin("pinned", { jobId: "j1", status: "pinned" }),
        pin("theirs", { jobId: "j2", pinnedBy: "them" }),
        pin("no-job"),
      ],
    };
    const result = leftoversOf(view, "me");
    expect(result.count).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].pinIds).toEqual(["mine"]);
  });

  it("drops cleared photos' candidates from the board, keeping everything else", () => {
    const view = {
      title: "kept",
      pins: [pin("a", { jobId: "j1" }), pin("b", { jobId: "j2" }), pin("c", { status: "pinned" })],
    };
    const { groups } = leftoversOf(view, "me");
    const j1 = groups.filter((g) => g.jobId === "j1");
    const next = withoutLeftovers(view, j1);
    expect(next.title).toBe("kept");
    expect(next.pins.map((p) => p.id)).toEqual(["b", "c"]);
    expect(withoutLeftovers(view, groups).pins.map((p) => p.id)).toEqual(["c"]);
  });
});
