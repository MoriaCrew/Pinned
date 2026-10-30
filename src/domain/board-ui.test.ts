import { describe, expect, it } from "vitest";
import type { ActivityLine } from "./board-activity";
import { pinCards, type BoardViewLike, type BoardViewScene } from "./board-view";
import {
  boardCounts,
  formatElapsed,
  isVisibleReadyScene,
  latestActivity,
  pickNumbers,
  pickedInOrder,
  remixSource,
  sceneCredits,
  sceneNumbers,
  sceneTag,
  stripItems,
  thingInSentence,
} from "./board-ui";
import { togglePinSelection } from "./make-sheet";

function scene(over: Partial<BoardViewScene> & { id: string }): BoardViewScene {
  return {
    createdBy: "p1",
    elementIds: ["e1"],
    prompt: "a picnic",
    status: "ready",
    imageUrl: `/img/${over.id}`,
    createdAt: 100,
    ...over,
  };
}

const participants = [
  { id: "p1", displayName: "Robin" },
  { id: "p2", displayName: "Sam" },
];

const elements = [
  { id: "e1", ownerId: "p1", label: "Teal Mug", faceFlag: false, imageUrl: "/e1" },
  { id: "e2", ownerId: "p2", label: "Rubber duck", faceFlag: false, imageUrl: "/e2" },
  { id: "e3", ownerId: "gone", label: "TV remote", faceFlag: false, imageUrl: "/e3" },
];

function boardView(over: Partial<BoardViewLike> = {}): BoardViewLike {
  return {
    participants,
    elements,
    pins: [
      { id: "pin1", elementId: "e1", pinnedBy: "p1", status: "pinned", createdAt: 10 },
      { id: "pin2", elementId: "e2", pinnedBy: "p2", status: "pinned", createdAt: 20 },
      { id: "pin3", elementId: "e3", pinnedBy: "p1", status: "candidate", createdAt: 30 },
    ],
    ...over,
  };
}

describe("board header counts (PIN-98)", () => {
  it("counts everyone, pinned things only and ready scenes with an image", () => {
    const counts = boardCounts({
      ...boardView(),
      scenes: [
        scene({ id: "s1" }),
        scene({ id: "s2", status: "running", imageUrl: null }),
        scene({ id: "s3", status: "failed", imageUrl: null }),
        scene({ id: "s4", status: "ready", imageUrl: null }),
      ],
    });
    expect(counts).toEqual({ people: 2, things: 2, scenes: 1 });
  });

  it("is all zeros on a brand-new board", () => {
    expect(boardCounts({ participants: [], elements: [], pins: [], scenes: [] })).toEqual({
      people: 0,
      things: 0,
      scenes: 0,
    });
  });

  it("treats only ready scenes with an image as visible prints", () => {
    expect(isVisibleReadyScene({ status: "ready", imageUrl: "/x" })).toBe(true);
    expect(isVisibleReadyScene({ status: "ready", imageUrl: null })).toBe(false);
    expect(isVisibleReadyScene({ status: "pending", imageUrl: null })).toBe(false);
  });
});

describe("thing names in a sentence (PIN-98)", () => {
  it("lower-cases names but keeps all-capital words and numbers", () => {
    expect(thingInSentence("Teal Mug")).toBe("teal mug");
    expect(thingInSentence("Biscuit the cat")).toBe("biscuit the cat");
    expect(thingInSentence("TV remote")).toBe("TV remote");
    expect(thingInSentence("R2D2 toy")).toBe("R2D2 toy");
    expect(thingInSentence("  Mug ")).toBe("mug");
  });
});

describe("latest activity line (PIN-98)", () => {
  const line = (over: Partial<ActivityLine>): ActivityLine => ({
    id: "a",
    kind: "pinned",
    actorName: "Sam",
    label: "Teal Mug",
    createdAt: 1,
    ...over,
  });

  it("is null when nothing happened yet", () => {
    expect(latestActivity([])).toBeNull();
  });

  it("takes the newest line (the server sends newest first) with the thing in sentence case", () => {
    expect(latestActivity([line({ id: "new" }), line({ id: "old", kind: "joined", label: null })])).toEqual({
      kind: "pinned",
      name: "Sam",
      thing: "teal mug",
    });
  });

  it("keeps a missing actor as null so the page can say Someone", () => {
    expect(latestActivity([line({ kind: "sceneReady", actorName: null, label: null })])).toEqual({
      kind: "sceneReady",
      name: null,
      thing: null,
    });
  });
});

describe("scene numbering (PIN-98)", () => {
  it("numbers ready prints from the oldest, skipping scenes that are not prints", () => {
    const numbers = sceneNumbers([
      scene({ id: "s3", createdAt: 300 }),
      scene({ id: "dev", createdAt: 250, status: "running", imageUrl: null }),
      scene({ id: "s1", createdAt: 100 }),
      scene({ id: "bad", createdAt: 150, status: "failed", imageUrl: null }),
      scene({ id: "s2", createdAt: 200 }),
    ]);
    expect([...numbers.entries()]).toEqual([
      ["s1", 1],
      ["s2", 2],
      ["s3", 3],
    ]);
    expect(numbers.has("dev")).toBe(false);
  });

  it("breaks timestamp ties by id so numbers never swap between polls", () => {
    const numbers = sceneNumbers([scene({ id: "b", createdAt: 5 }), scene({ id: "a", createdAt: 5 })]);
    expect(numbers.get("a")).toBe(1);
    expect(numbers.get("b")).toBe(2);
  });
});

describe("scene credits (PIN-98)", () => {
  it("maps elements to thing, owner and cut-out, skipping elements that left the board", () => {
    const credits = sceneCredits({ id: "s1", elementIds: ["e2", "missing", "e1"] }, elements, participants);
    expect(credits).toEqual([
      { thing: "rubber duck", owner: { id: "p2", name: "Sam" }, src: "/e2" },
      { thing: "teal mug", owner: { id: "p1", name: "Robin" }, src: "/e1" },
    ]);
  });

  it("leaves the owner out when they are no longer on the roster", () => {
    expect(sceneCredits({ elementIds: ["e3"] }, elements, participants)).toEqual([
      { thing: "TV remote", owner: null, src: "/e3" },
    ]);
  });

  it("credits a remix's own things first, then its parent's (PIN-79)", () => {
    const parent = scene({ id: "parent", elementIds: ["e1"] });
    const remix = scene({ id: "remix", elementIds: ["e2"], parentSceneId: "parent" });
    expect(sceneCredits(remix, elements, participants, [parent, remix]).map((c) => c.thing)).toEqual([
      "rubber duck",
      "teal mug",
    ]);
  });
});

describe("scene tag and remix source (PIN-98)", () => {
  it("says collage first, then remix, else a plain scene", () => {
    expect(sceneTag({ kind: "collage", parentSceneId: "p" })).toBe("collage");
    expect(sceneTag({ kind: "ai", parentSceneId: "p" })).toBe("remix");
    expect(sceneTag({ kind: "ai" })).toBe("scene");
    expect(sceneTag({})).toBe("scene");
  });

  it("names the parent's idea and maker, or nothing when the parent is gone", () => {
    const parent = scene({ id: "parent", prompt: "A tiny picnic", createdBy: "p2" });
    expect(remixSource({ parentSceneId: "parent" }, [parent], participants)).toEqual({
      title: "A tiny picnic",
      owner: "Sam",
    });
    expect(remixSource({ parentSceneId: "parent" }, [{ ...parent, createdBy: "gone" }], participants)).toEqual({
      title: "A tiny picnic",
    });
    expect(remixSource({ parentSceneId: "missing" }, [parent], participants)).toBeNull();
    expect(remixSource({}, [parent], participants)).toBeNull();
  });

  it("says the parent was deleted when the board view flags it (PIN-143)", () => {
    expect(remixSource({ parentSceneId: "gone", parentDeleted: true }, [], participants)).toEqual({ deleted: true });
    expect(remixSource({ parentDeleted: true }, [], participants)).toBeNull();
  });
});

describe("scenes strip (PIN-98)", () => {
  const scenes = [
    scene({ id: "mine-failed", status: "failed", imageUrl: null }),
    scene({ id: "other-refused", status: "refused", imageUrl: null }),
    scene({ id: "other-running", status: "running", imageUrl: null }),
    scene({ id: "pending", status: "pending", imageUrl: null }),
    scene({ id: "ready" }),
    scene({ id: "no-image", status: "ready", imageUrl: null }),
  ];

  it("shows prints, anyone's developing scenes and only my attempt's failure", () => {
    expect(stripItems(scenes, "mine-failed").map((i) => [i.scene.id, i.mode, i.mine])).toEqual([
      ["mine-failed", "problem", true],
      ["other-running", "developing", false],
      ["pending", "developing", false],
      ["ready", "print", false],
    ]);
  });

  it("hides every failed or refused scene when there is no attempt in this session", () => {
    expect(stripItems(scenes, null).map((i) => i.scene.id)).toEqual(["other-running", "pending", "ready"]);
  });

  it("marks my developing attempt as mine", () => {
    expect(stripItems(scenes, "pending").find((i) => i.scene.id === "pending")?.mine).toBe(true);
  });
});

describe("picking order (PIN-98)", () => {
  const cards = pinCards(
    boardView({
      pins: [
        { id: "pin1", elementId: "e1", pinnedBy: "p1", status: "pinned", createdAt: 10 },
        { id: "pin2", elementId: "e2", pinnedBy: "p2", status: "pinned", createdAt: 20 },
        { id: "pin3", elementId: "e3", pinnedBy: "p1", status: "pinned", createdAt: 30 },
        { id: "cand", elementId: "e3", pinnedBy: "p1", status: "candidate", createdAt: 40 },
      ],
    }),
  );

  it("keeps tap order, not board order, and numbers from 1", () => {
    let selected: Set<string> = new Set();
    for (const pinId of ["pin3", "pin1", "pin2"]) selected = togglePinSelection(selected, pinId, 4).next;
    expect(pickedInOrder(cards, selected).map((c) => c.pinId)).toEqual(["pin3", "pin1", "pin2"]);
    expect([...pickNumbers(cards, selected).entries()]).toEqual([
      ["pin3", 1],
      ["pin1", 2],
      ["pin2", 3],
    ]);
  });

  it("renumbers after a drop and appends a new pick at the end", () => {
    let selected: Set<string> = new Set(["pin3", "pin1", "pin2"]);
    selected = togglePinSelection(selected, "pin1", 4).next;
    selected = togglePinSelection(selected, "pin1", 4).next;
    expect(pickedInOrder(cards, selected).map((c) => c.pinId)).toEqual(["pin3", "pin2", "pin1"]);
  });

  it("skips picks that are not selectable (candidates, pins gone)", () => {
    expect(pickedInOrder(cards, new Set(["cand", "gone", "pin2"])).map((c) => c.pinId)).toEqual(["pin2"]);
  });
});

describe("developing clock (PIN-98)", () => {
  it("formats elapsed time as m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(12_400)).toBe("0:12");
    expect(formatElapsed(62_000)).toBe("1:02");
    expect(formatElapsed(-5)).toBe("0:00");
    expect(formatElapsed(Number.NaN)).toBe("0:00");
  });
});
