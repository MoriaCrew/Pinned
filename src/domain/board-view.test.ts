import { describe, expect, it } from "vitest";
import { canDeleteCard, createBoardPayload, needsEmptyPrompt, pinCards, type BoardViewLike } from "./board-view";

function view(over: Partial<BoardViewLike> = {}): BoardViewLike {
  return {
    participants: [
      { id: "p1", displayName: "Robin" },
      { id: "p2", displayName: "Aye" },
    ],
    elements: [
      { id: "e1", ownerId: "p1", label: "mug", faceFlag: false, imageUrl: "/e1" },
      { id: "e2", ownerId: "p2", label: "cat", faceFlag: true, imageUrl: "/e2" },
    ],
    pins: [
      { id: "pin2", elementId: "e2", pinnedBy: "p2", status: "pinned", createdAt: 200 },
      { id: "pin1", elementId: "e1", pinnedBy: "p1", status: "pinned", createdAt: 100 },
      { id: "pinX", elementId: "gone", pinnedBy: "p1", status: "pinned", createdAt: 50 },
    ],
    ...over,
  };
}

describe("board view model (PIN-66)", () => {
  it("joins pins to elements and owner names, oldest first, skipping missing elements", () => {
    const cards = pinCards(view());
    expect(cards.map((c) => [c.element.label, c.ownerName])).toEqual([
      ["mug", "Robin"],
      ["cat", "Aye"],
    ]);
  });

  it("keeps each pin's createdAt on its card for the filter row (PIN-218)", () => {
    expect(pinCards(view()).map((c) => [c.pinId, c.createdAt])).toEqual([
      ["pin1", 100],
      ["pin2", 200],
    ]);
  });

  it("shows delete only on own pins (PIN-77: element owner, not pinnedBy)", () => {
    const cards = pinCards(view());
    expect(canDeleteCard(cards[0], "p1")).toBe(true);
    expect(canDeleteCard(cards[0], "p2")).toBe(false);
    expect(canDeleteCard(cards[1], "p2")).toBe(true);
    expect(canDeleteCard(cards[0], null)).toBe(false);
    expect(canDeleteCard(cards[0], undefined)).toBe(false);
  });

  it("leaves ownerName null for an unknown owner so the UI can fall back", () => {
    const cards = pinCards(view({ participants: [] }));
    expect(cards.every((c) => c.ownerName === null)).toBe(true);
  });

  it("needs the empty prompt until a pinned (not candidate) pin exists", () => {
    expect(needsEmptyPrompt(view({ pins: [] }))).toBe(true);
    expect(
      needsEmptyPrompt(
        view({ pins: [{ id: "c", elementId: "e1", pinnedBy: "p1", status: "candidate", createdAt: 1 }] }),
      ),
    ).toBe(true);
    expect(needsEmptyPrompt(view())).toBe(false);
  });

  it("builds a create payload: trims title, theme optional, Policy cap enforced", () => {
    expect(createBoardPayload("  Kitchen   chaos ", null, 80)).toEqual({
      ok: true,
      payload: { title: "Kitchen chaos" },
    });
    expect(createBoardPayload("Tea", "gran", 80)).toEqual({
      ok: true,
      payload: { title: "Tea", themeId: "gran" },
    });
    expect(createBoardPayload("   ", null, 80)).toEqual({ ok: false, reason: "empty" });
    expect(createBoardPayload("x".repeat(81), null, 80)).toEqual({ ok: false, reason: "tooLong" });
    expect(createBoardPayload("Tea", "nope", 80)).toEqual({ ok: false, reason: "badTheme" });
  });
});
