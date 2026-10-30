import { describe, expect, it } from "vitest";
import {
  appendDictation,
  applyChip,
  chipThumbs,
  chipsForSelection,
  chipsSelectionKey,
  isTerminalScene,
  pruneSelection,
  canRemixScene,
  sceneCreditElementIds,
  sceneCreditParts,
  scenePayload,
  scenesNewestFirst,
  selectableCards,
  selectedCards,
  togglePinSelection,
} from "./make-sheet";
import type { BoardViewScene, PinCard } from "./board-view";

const CHIPS = ["on a sunny picnic blanket", "floating in space"];

function card(pinId: string, elementId: string, status: "pinned" | "candidate" = "pinned"): PinCard {
  return {
    pinId,
    element: { id: elementId, ownerId: "me", label: elementId, faceFlag: false, imageUrl: `/${elementId}` },
    status,
    ownerName: "Robin",
    ownerId: "me",
  };
}

describe("generated chips selection guard (PIN-75)", () => {
  it("selection key ignores pick order and duplicates", () => {
    expect(chipsSelectionKey(["e2", "e1", "e2"])).toBe(chipsSelectionKey(["e1", "e2"]));
    expect(chipsSelectionKey(["e1"])).not.toBe(chipsSelectionKey(["e1", "e2"]));
  });

  it("generated chips render only for the exact selection they were made for", () => {
    const fallback = ["on a sunny picnic blanket"];
    const generated = { key: chipsSelectionKey(["e1", "e2"]), chips: ["in space"] };
    expect(chipsForSelection(generated, chipsSelectionKey(["e2", "e1"]), fallback)).toEqual(["in space"]);
    // A stale response for earlier picks must not swap in.
    expect(chipsForSelection(generated, chipsSelectionKey(["e1"]), fallback)).toEqual(fallback);
    expect(chipsForSelection(null, chipsSelectionKey(["e1"]), fallback)).toEqual(fallback);
    expect(
      chipsForSelection({ key: chipsSelectionKey(["e1"]), chips: [] }, chipsSelectionKey(["e1"]), fallback),
    ).toEqual(fallback);
  });
});

describe("chip thumbnails (PIN-100)", () => {
  const chips = ["a", "b", "c", "d", "e"];

  it("gives chip i the i-th picked sticker, wrapping round", () => {
    const cards = [card("p1", "e1"), card("p2", "e2"), card("p3", "e3")];
    expect(chipThumbs(chips, cards)).toEqual(["/e1", "/e2", "/e3", "/e1", "/e2"]);
  });

  it("counts picks that share an image once", () => {
    const cards = [card("p1", "e1"), card("p9", "e1"), card("p2", "e2")];
    expect(chipThumbs(chips.slice(0, 3), cards)).toEqual(["/e1", "/e2", "/e1"]);
  });

  it("leaves chips bare when fewer than two distinct stickers are picked", () => {
    expect(chipThumbs(chips.slice(0, 2), [])).toEqual([undefined, undefined]);
    expect(chipThumbs(chips.slice(0, 2), [card("p1", "e1")])).toEqual([undefined, undefined]);
    expect(chipThumbs(chips.slice(0, 2), [card("p1", "e1"), card("p9", "e1")])).toEqual([
      undefined,
      undefined,
    ]);
    expect(chipThumbs([], [card("p1", "e1"), card("p2", "e2")])).toEqual([]);
  });
});

describe("make sheet logic (PIN-70)", () => {
  it("only pinned pins are selectable, never candidates", () => {
    const cards = [card("p1", "e1"), card("c1", "e2", "candidate")];
    expect(selectableCards(cards).map((c) => c.pinId)).toEqual(["p1"]);
    expect(selectedCards(cards, new Set(["p1", "c1"])).map((c) => c.pinId)).toEqual(["p1"]);
  });

  it("toggles picks and rejects (never evicts) at the Policy cap", () => {
    const one = togglePinSelection(new Set(), "p1", 2);
    expect([...one.next]).toEqual(["p1"]);
    expect(one.rejected).toBe(false);
    const two = togglePinSelection(one.next, "p2", 2);
    const three = togglePinSelection(two.next, "p3", 2);
    expect(three.rejected).toBe(true);
    expect([...three.next].sort()).toEqual(["p1", "p2"]);
    const dropped = togglePinSelection(three.next, "p1", 2);
    expect([...dropped.next]).toEqual(["p2"]);
    expect(dropped.rejected).toBe(false);
  });

  it("prunes picks whose pin left the board", () => {
    expect([...pruneSelection(new Set(["p1", "gone"]), ["p1", "p2"])]).toEqual(["p1"]);
  });

  it("chips fill, swap, extend, and never duplicate or bust the cap", () => {
    expect(applyChip("", CHIPS[0], CHIPS, 500)).toBe("on a sunny picnic blanket");
    expect(applyChip("on a sunny picnic blanket", CHIPS[1], CHIPS, 500)).toBe("floating in space");
    // PIN-75 swap: with fixed + generated chips both known, a
    // prompt that is just a fixed chip still swaps, not appends.
    expect(
      applyChip("on a sunny picnic blanket", "napping in a sunbeam", [...CHIPS, "napping in a sunbeam"], 500),
    ).toBe("napping in a sunbeam");
    expect(applyChip("a tiny picnic", CHIPS[1], CHIPS, 500)).toBe("a tiny picnic floating in space");
    expect(applyChip("a tiny picnic floating in space", CHIPS[1], CHIPS, 500)).toBe(
      "a tiny picnic floating in space",
    );
    expect(applyChip("1234567890", CHIPS[1], CHIPS, 12)).toBe("1234567890");
  });

  it("appendDictation fills, appends, trims the stop and caps (PIN-119)", () => {
    expect(appendDictation("", "A tiny picnic on the lawn.", 500)).toBe("A tiny picnic on the lawn");
    expect(appendDictation("a tiny picnic", "floating in space", 500)).toBe("a tiny picnic floating in space");
    expect(appendDictation("a tiny picnic", "   ", 500)).toBe("a tiny picnic");
    expect(appendDictation("abcdefghij", "klmnopqrst", 12)).toBe("abcdefghij k");
    expect(appendDictation("", "one   two\nthree!", 500)).toBe("one two three");
  });

  it("builds the scene payload only inside the Policy ranges", () => {
    const cards = [card("p1", "e1"), card("p2", "e2")];
    expect(scenePayload(cards, "  a  picnic  ", "s1", { min: 1, max: 4 }, 500)).toEqual({
      elementIds: ["e1", "e2"],
      prompt: "a picnic",
      sceneId: "s1",
    });
    // Two pins of one element count once.
    expect(
      scenePayload([card("p1", "e1"), card("p9", "e1")], "x", "s1", { min: 2, max: 4 }, 500),
    ).toBeNull();
    expect(scenePayload(cards, "   ", "s1", { min: 1, max: 4 }, 500)).toBeNull();
    expect(scenePayload(cards, "x".repeat(11), "s1", { min: 1, max: 4 }, 10)).toBeNull();
    expect(scenePayload(cards, "ok", "", { min: 1, max: 4 }, 500)).toBeNull();
    expect(
      scenePayload([...cards, card("p3", "e3")], "ok", "s1", { min: 1, max: 2 }, 500),
    ).toBeNull();
  });

  it("treats ready/failed/refused scenes as terminal and sorts newest first", () => {
    expect(isTerminalScene("ready")).toBe(true);
    expect(isTerminalScene("refused")).toBe(true);
    expect(isTerminalScene("running")).toBe(false);
    const scene = (id: string, createdAt: number): BoardViewScene => ({
      id,
      createdBy: "me",
      elementIds: ["e1"],
      prompt: "x",
      status: "ready",
      imageUrl: "/img",
      createdAt,
    });
    expect(scenesNewestFirst([scene("a", 1), scene("b", 3), scene("c", 3)]).map((s) => s.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("remix (PIN-79): credits union parent + new owners deduped, new first, chains walked", () => {
    const view = (id: string, elementIds: string[], parentSceneId?: string): BoardViewScene => ({
      id,
      createdBy: "me",
      elementIds,
      ...(parentSceneId ? { parentSceneId } : {}),
      prompt: "x",
      status: "ready",
      imageUrl: `/${id}`,
      createdAt: 1,
    });
    const grand = view("s0", ["e1"]);
    const parent = view("s1", ["e2", "e1"], "s0");
    const child = view("s2", ["e3", "e2"], "s1");
    expect(sceneCreditElementIds(child, [grand, parent, child])).toEqual(["e3", "e2", "e1"]);
    // Missing parent just ends the walk; a self-parent cannot loop.
    expect(sceneCreditElementIds(view("sx", ["e9"], "gone"), [])).toEqual(["e9"]);
    expect(sceneCreditElementIds(view("sy", ["e8"], "sy"), [view("sy", ["e8"], "sy")])).toEqual(["e8"]);
    const elements = [
      { id: "e1", ownerId: "me", label: "mug", faceFlag: false, imageUrl: "/e1" },
      { id: "e2", ownerId: "aye", label: "cat", faceFlag: false, imageUrl: "/e2" },
      { id: "e3", ownerId: "me", label: "duck", faceFlag: false, imageUrl: "/e3" },
    ];
    const participants = [
      { id: "me", displayName: "Robin" },
      { id: "aye", displayName: "Aye" },
    ];
    expect(sceneCreditParts(child, elements, participants, [grand, parent, child])).toEqual([
      { ownerName: "Robin", label: "duck" },
      { ownerName: "Aye", label: "cat" },
      { ownerName: "Robin", label: "mug" },
    ]);
  });

  it("remix (PIN-79): payload carries the parent and only ready scenes can remix", () => {
    const cards = [card("p1", "e1")];
    expect(scenePayload(cards, "add confetti", "s9", { min: 1, max: 4 }, 120, "s1")).toEqual({
      elementIds: ["e1"],
      prompt: "add confetti",
      sceneId: "s9",
      parentSceneId: "s1",
    });
    expect(scenePayload(cards, "fresh", "s9", { min: 1, max: 4 }, 120)).not.toHaveProperty("parentSceneId");
    expect(canRemixScene({ status: "ready", imageUrl: "/x" })).toBe(true);
    expect(canRemixScene({ status: "ready", imageUrl: null })).toBe(false);
    expect(canRemixScene({ status: "running", imageUrl: "/x" })).toBe(false);
  });

  it("credits scene elements to their owners and skips vanished elements", () => {
    const elements = [
      { id: "e1", ownerId: "me", label: "mug", faceFlag: false, imageUrl: "/e1" },
      { id: "e2", ownerId: "aye", label: "cat", faceFlag: false, imageUrl: "/e2" },
    ];
    const participants = [
      { id: "me", displayName: "Robin" },
      { id: "aye", displayName: "Aye" },
    ];
    expect(sceneCreditParts({ elementIds: ["e1", "gone", "e2"] }, elements, participants)).toEqual([
      { ownerName: "Robin", label: "mug" },
      { ownerName: "Aye", label: "cat" },
    ]);
  });
});
