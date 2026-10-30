import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LibraryStripView } from "../../../domain/library-strip";
import type { MyPinCard } from "../../../domain/my-pins";
import { LibraryList, LibraryStrip } from "./LibraryPins";

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
