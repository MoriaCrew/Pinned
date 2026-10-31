import { describe, expect, it } from "vitest";
import {
  DEMO_BOARD_TITLE,
  DEMO_PARTICIPANTS,
  isDemoBoardTitle,
  pickSceneElementIds,
  sameSeedCounts,
  summarizeSeedCounts,
} from "./demo-seed";

describe("demo-seed plan (PIN-73)", () => {
  it("has 2 demo participants, each with a PIN-50 synthetic fixture photo", () => {
    expect(DEMO_PARTICIPANTS).toHaveLength(2);
    for (const p of DEMO_PARTICIPANTS) {
      expect(p.displayName).toMatch(/^Demo /);
      expect(p.photoPath).toMatch(/^eval\/fixtures\/studio\/photos\/.+\.jpg$/);
    }
    expect(new Set(DEMO_PARTICIPANTS.map((p) => p.photoPath)).size).toBe(2);
  });

  it("recognizes only the deterministic title marker", () => {
    expect(isDemoBoardTitle(DEMO_BOARD_TITLE)).toBe(true);
    expect(isDemoBoardTitle("Family board")).toBe(false);
    expect(isDemoBoardTitle("")).toBe(false);
  });

  it("summarizes counts from a board view (pinned + ready only)", () => {
    const counts = summarizeSeedCounts({
      participants: [{}, {}],
      pins: [{ status: "pinned" }, { status: "pinned" }, { status: "candidate" }],
      elements: [{}, {}, {}],
      scenes: [{ status: "ready" }, { status: "pending" }, { status: "refused" }],
    });
    expect(counts).toEqual({
      participants: 2,
      pinnedPins: 2,
      elements: 3,
      readyScenes: 1,
    });
    expect(summarizeSeedCounts({})).toEqual({
      participants: 0,
      pinnedPins: 0,
      elements: 0,
      readyScenes: 0,
    });
  });

  it("sameSeedCounts is the seed-twice equivalence check", () => {
    const a = { participants: 2, pinnedPins: 6, elements: 6, readyScenes: 1 };
    expect(sameSeedCounts(a, { ...a })).toBe(true);
    expect(sameSeedCounts(a, { ...a, pinnedPins: 5 })).toBe(false);
    expect(sameSeedCounts(a, { ...a, readyScenes: 0 })).toBe(false);
  });

  it("pickSceneElementIds mixes owners first, then fills up to max", () => {
    const els = [
      { id: "a1", ownerId: "mia" },
      { id: "a2", ownerId: "mia" },
      { id: "b1", ownerId: "sam" },
      { id: "b2", ownerId: "sam" },
    ];
    expect(pickSceneElementIds(els, 3)).toEqual(["a1", "b1", "a2"]);
    expect(pickSceneElementIds(els, 1)).toEqual(["a1"]);
    expect(pickSceneElementIds(els, 0)).toEqual([]);
    expect(pickSceneElementIds([], 3)).toEqual([]);
  });
});
