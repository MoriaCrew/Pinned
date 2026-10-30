import { describe, expect, it } from "vitest";
import {
  STRIP_PLACEHOLDER_COUNT,
  familiesOnBoard,
  familyOf,
  libraryPinState,
  libraryStripView,
  type LibraryPinState,
  type StripBoardLike,
} from "./library-strip";
import type { MyPinCard } from "./my-pins";

const card = (elementId: string, over: Partial<MyPinCard> = {}): MyPinCard => ({
  elementId,
  label: elementId,
  description: "",
  faceFlag: false,
  sourceBoardTitle: "Kitchen chaos",
  imageUrl: `/api/me/elements/${elementId}/image?kind=cutout`,
  createdAt: 1,
  ...over,
});

const EMPTY_BOARD: StripBoardLike = { pins: [], elements: [] };
const none = new Map<string, LibraryPinState>();

const view = (over: Partial<Parameters<typeof libraryStripView>[0]> = {}) =>
  libraryStripView({
    signedIn: true,
    status: "success",
    cards: [card("mug"), card("lamp")],
    board: EMPTY_BOARD,
    local: none,
    max: 12,
    ...over,
  });

describe("library strip (PIN-121)", () => {
  it("is hidden when signed out, whatever the library holds", () => {
    expect(view({ signedIn: false })).toEqual({ kind: "hidden" });
    expect(view({ signedIn: false, status: "pending" })).toEqual({ kind: "hidden" });
  });

  it("is hidden for an empty library, and when Policy turns it off", () => {
    expect(view({ cards: [] })).toEqual({ kind: "hidden" });
    expect(view({ max: 0 })).toEqual({ kind: "hidden" });
  });

  it("shows sticker placeholders while loading and one problem state on error", () => {
    expect(view({ status: "pending", cards: undefined })).toEqual({
      kind: "loading",
      placeholders: STRIP_PLACEHOLDER_COUNT,
    });
    // Never more placeholders than the strip could hold.
    expect(view({ status: "pending", max: 2 })).toEqual({ kind: "loading", placeholders: 2 });
    expect(view({ status: "error", cards: undefined })).toEqual({ kind: "error" });
  });

  it("lists library things newest first as the library sorts them, all idle", () => {
    const result = view();
    expect(result.kind).toBe("items");
    if (result.kind !== "items") return;
    expect(result.items.map((item) => [item.card.elementId, item.state])).toEqual([
      ["mug", "idle"],
      ["lamp", "idle"],
    ]);
  });

  it("caps the strip at Policy.libraryStripMax", () => {
    const cards = ["a", "b", "c", "d", "e"].map((id) => card(id));
    const result = view({ cards, max: 3 });
    expect(result.kind === "items" && result.items.map((i) => i.card.elementId)).toEqual(["a", "b", "c"]);
  });

  it("leaves out this board's own things and shows a family pinned here as already here", () => {
    // lamp (board A) was pinned here as a copy; the copy is in the
    // library too, and so is a thing that was born on this board.
    const cards = [
      card("copy-of-lamp", { familyId: "lamp" }),
      card("native-here"),
      card("mug"),
      card("lamp", { familyId: "lamp" }),
    ];
    const board: StripBoardLike = {
      elements: [{ id: "copy-of-lamp" }, { id: "native-here" }],
      pins: [
        { elementId: "copy-of-lamp", status: "pinned" },
        { elementId: "native-here", status: "pinned" },
      ],
    };
    const result = view({ cards, board });
    expect(result.kind === "items" && result.items.map((i) => [i.card.elementId, i.state])).toEqual([
      ["mug", "idle"],
      ["lamp", "already"],
    ]);
  });

  it("is hidden when everything in the library lives on this board", () => {
    const board: StripBoardLike = {
      elements: [{ id: "mug" }, { id: "lamp" }],
      pins: [
        { elementId: "mug", status: "pinned" },
        { elementId: "lamp", status: "candidate" },
      ],
    };
    expect(view({ board })).toEqual({ kind: "hidden" });
  });

  it("shows one sticker per family (the newest member)", () => {
    const cards = [card("copy-on-b", { familyId: "hat" }), card("hat", { familyId: "hat" }), card("mug")];
    const result = view({ cards });
    expect(result.kind === "items" && result.items.map((i) => i.card.elementId)).toEqual(["copy-on-b", "mug"]);
  });

  it("keeps what this sheet did over the board's state: pinned stays pinned after the refetch", () => {
    const local = new Map<string, LibraryPinState>([
      ["mug", "pinned"],
      ["lamp", "failed"],
    ]);
    // After the refetches the board (and library) hold mug's new copy.
    const cards = [card("copy-of-mug", { familyId: "mug" }), card("mug"), card("lamp")];
    const board: StripBoardLike = {
      elements: [{ id: "copy-of-mug" }],
      pins: [{ elementId: "copy-of-mug", status: "pinned" }],
    };
    const result = view({ cards, local, board });
    expect(result.kind === "items" && result.items.map((i) => [i.card.elementId, i.state])).toEqual([
      ["mug", "pinned"],
      ["lamp", "failed"],
    ]);
  });
});

describe("library pin state helpers (PIN-121)", () => {
  it("treats an original as its own family", () => {
    expect(familyOf(card("lamp"))).toBe("lamp");
    expect(familyOf(card("copy", { familyId: "lamp" }))).toBe("lamp");
  });

  it("only pinned members put a family on the board", () => {
    const cards = [card("a"), card("b", { familyId: "root" }), card("c")];
    const board: StripBoardLike = {
      elements: [],
      pins: [
        { elementId: "a", status: "candidate" },
        { elementId: "b", status: "pinned" },
      ],
    };
    expect([...familiesOnBoard(cards, board)]).toEqual(["root"]);
  });

  it("marks the full list's rows: local state, then already here, else idle", () => {
    const onBoard = new Set(["lamp"]);
    const local = new Map<string, LibraryPinState>([["mug", "pinning"]]);
    expect(libraryPinState(card("mug"), local, onBoard)).toBe("pinning");
    expect(libraryPinState(card("lamp"), local, onBoard)).toBe("already");
    expect(libraryPinState(card("hat"), local, onBoard)).toBe("idle");
  });
});
