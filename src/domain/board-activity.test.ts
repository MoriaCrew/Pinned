import { beforeEach, describe, expect, it } from "vitest";
import type { BoardEvent } from "./board";
import { activityLines } from "./board-activity";

const participants = [
  { id: "part-1", displayName: "Aye" },
  { id: "part-2", displayName: "Robin" },
];
const elements = [
  { id: "el-1", label: "Brass Lamp" },
  { id: "el-2", label: "Red Mug" },
];

let seq = 0;
beforeEach(() => {
  seq = 0;
});
function event(over: Partial<BoardEvent>): BoardEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    boardId: "board-1",
    type: "pin_added",
    actorId: "part-1",
    createdAt: seq * 1000,
    ...over,
  };
}

describe("activityLines (PIN-74)", () => {
  it("empty: no events, and only non-strip events, give no lines", () => {
    expect(activityLines([], participants, elements, 5)).toEqual([]);
    expect(
      activityLines(
        [
          event({ type: "element_added", elementId: "el-1" }),
          event({ type: "scene_requested", sceneId: "s1" }),
          event({ type: "scene_refused", sceneId: "s1" }),
          event({ type: "scene_failed", sceneId: "s2" }),
        ],
        participants,
        elements,
        5,
      ),
    ).toEqual([]);
  });

  it("single: a pin becomes '<actor> pinned <label>' data", () => {
    const lines = activityLines(
      [event({ type: "pin_added", elementId: "el-1" })],
      participants,
      elements,
      5,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "pinned",
      actorName: "Aye",
      label: "Brass Lamp",
    });
  });

  it("many: newest first, capped at max, joined + scene lines included", () => {
    const events = [
      event({ type: "participant_joined" }),
      event({ type: "pin_added", elementId: "el-1" }),
      event({
        type: "participant_joined",
        actorId: "part-2",
        createdAt: 2500,
      }),
      event({ type: "pin_added", actorId: "part-2", elementId: "el-2" }),
      event({ type: "scene_ready", actorId: "part-2", sceneId: "s1" }),
      event({ type: "pin_added", elementId: "el-1", createdAt: 9000 }),
    ];
    const lines = activityLines(events, participants, elements, 3);
    expect(lines.map((l) => l.kind)).toEqual(["pinned", "sceneReady", "pinned"]);
    expect(lines[0].label).toBe("Brass Lamp");
    expect(lines[1]).toMatchObject({ actorName: "Robin", label: null });
    expect(lines[2]).toMatchObject({ actorName: "Robin", label: "Red Mug" });

    const all = activityLines(events, participants, elements, 50);
    expect(all.map((l) => l.kind)).toEqual([
      "pinned",
      "sceneReady",
      "pinned",
      "joined",
      "pinned",
      "joined",
    ]);
  });

  it("skips pins whose element is gone; unknown actor falls back to null", () => {
    const lines = activityLines(
      [
        event({ type: "pin_added", elementId: "el-deleted" }),
        event({ type: "participant_joined", actorId: "ghost" }),
      ],
      participants,
      elements,
      5,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "joined", actorName: null });
  });

  it("max <= 0 shows nothing", () => {
    expect(
      activityLines(
        [event({ type: "pin_added", elementId: "el-1" })],
        participants,
        elements,
        0,
      ),
    ).toEqual([]);
  });
});
