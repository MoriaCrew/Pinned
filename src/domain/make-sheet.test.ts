import { describe, expect, it } from "vitest";
import {
  applyChip,
  isTerminalScene,
  pruneSelection,
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
    expect(applyChip("a tiny picnic", CHIPS[1], CHIPS, 500)).toBe("a tiny picnic floating in space");
    expect(applyChip("a tiny picnic floating in space", CHIPS[1], CHIPS, 500)).toBe(
      "a tiny picnic floating in space",
    );
    expect(applyChip("1234567890", CHIPS[1], CHIPS, 12)).toBe("1234567890");
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
