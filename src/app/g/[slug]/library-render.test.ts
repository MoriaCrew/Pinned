import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { familiesOnBoard, libraryPinState, libraryStripView, type LibraryStripView } from "../../../domain/library-strip";
import type { MyPinCard } from "../../../domain/my-pins";
import { LibraryList, LibraryStrip, withLibraryCopy } from "./LibraryPins";

const card = (elementId: string, label: string): MyPinCard => ({
  elementId,
  label,
  description: "",
  faceFlag: false,
  sourceBoardTitle: "Kitchen chaos",
  imageUrl: `/api/me/elements/${elementId}/image?kind=cutout`,
  createdAt: 1,
});

const noop = () => {};
const strip = (view: Exclude<LibraryStripView, { kind: "hidden" }>) =>
  renderToStaticMarkup(h(LibraryStrip, { view, headingId: "strip", onPin: noop, onSeeAll: noop, onRetry: noop }));

describe("From your other boards strip (PIN-121)", () => {
  it("titles the strip, offers See all and one tap per sticker", () => {
    const out = strip({
      kind: "items",
      items: [
        { card: card("mug", "Teal mug"), state: "idle" },
        { card: card("lamp", "Brass lamp"), state: "pinned" },
        { card: card("hat", "Straw hat"), state: "already" },
        { card: card("duck", "Rubber duck"), state: "failed" },
      ],
    });
    expect(out).toContain("From your other boards");
    expect(out).toContain("See all");
    expect(out).toContain('aria-label="Pin here: Teal mug"');
    expect(out).toContain('aria-label="Pinned: Brass lamp"');
    expect(out).toContain('aria-label="Already here: Straw hat"');
    expect(out).toContain('aria-label="Try again: Rubber duck"');
    // Pinned shows a check; already here is greyed and inert; a failure stays tappable.
    expect(out).toContain("pn-add-strip-check");
    expect(out).toMatch(/data-state="already" aria-label="Already here: Straw hat" aria-disabled="true"/);
    expect(out).toMatch(/data-state="dropped"/);
    expect(out).not.toMatch(/aria-label="Try again: Rubber duck" aria-disabled/);
  });

  it("loads as pulsing sticker placeholders with no spinner and no See all", () => {
    const out = strip({ kind: "loading", placeholders: 4 });
    expect(out.match(/pn-add-strip-ghost"/g)).toHaveLength(4);
    expect(out).toContain("Getting your pins");
    expect(out).not.toContain("See all");
  });

  it("shows a load error as one line and Try again", () => {
    const out = strip({ kind: "error" });
    expect(out).toContain("Couldn&#x27;t load your pins.");
    expect(out).toContain("Try again");
    expect(out).not.toContain("See all");
  });
});

describe("See all list (PIN-85 rows, PIN-121)", () => {
  it("keeps the rows: source board, Pin here, settled states", () => {
    const states = new Map([
      ["lamp", "already" as const],
      ["hat", "pinned" as const],
    ]);
    const out = renderToStaticMarkup(
      h(LibraryList, {
        status: "success",
        cards: [card("mug", "Teal mug"), card("lamp", "Brass lamp"), card("hat", "Straw hat")],
        stateOf: (c: MyPinCard) => states.get(c.elementId) ?? "idle",
        onPin: noop,
        onRetry: noop,
      }),
    );
    expect(out).toContain("From Kitchen chaos");
    expect(out).toContain('aria-label="Pin here: Teal mug"');
    expect(out).toContain("Already here");
    expect(out).toContain("Pinned");
  });
});

describe("library cache after a pin (PIN-121)", () => {
  const library = { elements: [card("lamp", "Brass lamp"), card("mug", "Teal mug")], total: 2, limit: 60 };
  // The pin made a copy with a new id; the board refetch has it pinned.
  const board = {
    elements: [{ id: "copy-of-lamp" }],
    pins: [{ elementId: "copy-of-lamp", status: "pinned" as const }],
  };

  it("adds the copy at the end, same family, labelled with this board", () => {
    const next = withLibraryCopy(library, library.elements[0], "copy-of-lamp", "Mia's birthday");
    expect(next.elements.map((c) => c.elementId)).toEqual(["lamp", "mug", "copy-of-lamp"]);
    expect(next.elements[2]).toMatchObject({ familyId: "lamp", sourceBoardTitle: "Mia's birthday", label: "Brass lamp" });
    expect(next.total).toBe(3);
    // Already listed: unchanged.
    expect(withLibraryCopy(next, library.elements[0], "copy-of-lamp", "Mia's birthday")).toBe(next);
  });

  it("reads Already here after the sheet reopens, before the library refetch lands", () => {
    // Reopened sheet: no local state any more.
    const none = new Map();
    const stale = familiesOnBoard(library.elements, board);
    expect(libraryPinState(library.elements[0], none, stale)).toBe("idle");
    const next = withLibraryCopy(library, library.elements[0], "copy-of-lamp", "Mia's birthday");
    const onBoard = familiesOnBoard(next.elements, board);
    expect(libraryPinState(next.elements[0], none, onBoard)).toBe("already");
    // The strip keeps the original as the family's sticker and leaves the copy (on this board) out.
    const view = libraryStripView({ signedIn: true, status: "success", cards: next.elements, board, local: none, max: 12 });
    expect(view.kind === "items" && view.items.map((i) => [i.card.elementId, i.state])).toEqual([
      ["lamp", "already"],
      ["mug", "idle"],
    ]);
  });
});
