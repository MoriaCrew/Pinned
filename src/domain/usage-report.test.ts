import { describe, expect, it } from "vitest";
import { totalUsage, usageFromBoardView } from "./usage-report";

function view(title: string, counters: unknown) {
  return { board: { title, counters } };
}

describe("usage report aggregation (PIN-74)", () => {
  it("reads honest counts from a board view's counters", () => {
    expect(
      usageFromBoardView(
        view("Demo", {
          participantCount: 2,
          elementCount: 7,
          pinCount: 6,
          sceneCount: 1,
        }),
      ),
    ).toEqual({ title: "Demo", participants: 2, elements: 7, pins: 6, scenes: 1 });
  });

  it("rejects malformed views instead of inventing numbers", () => {
    expect(usageFromBoardView(null)).toBeNull();
    expect(usageFromBoardView({})).toBeNull();
    expect(usageFromBoardView(view("X", { participantCount: -1 }))).toBeNull();
    expect(
      usageFromBoardView(
        view("X", {
          participantCount: 1.5,
          elementCount: 0,
          pinCount: 0,
          sceneCount: 0,
        }),
      ),
    ).toBeNull();
  });

  it("totals across boards; empty input is all zeros", () => {
    expect(totalUsage([])).toEqual({
      boards: 0,
      people: 0,
      elements: 0,
      pins: 0,
      scenes: 0,
    });
    const a = usageFromBoardView(
      view("A", { participantCount: 2, elementCount: 7, pinCount: 6, sceneCount: 1 }),
    )!;
    const b = usageFromBoardView(
      view("B", { participantCount: 3, elementCount: 4, pinCount: 4, sceneCount: 2 }),
    )!;
    expect(totalUsage([a, b])).toEqual({
      boards: 2,
      people: 5,
      elements: 11,
      pins: 10,
      scenes: 3,
    });
  });
});
