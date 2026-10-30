import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PinCard } from "../../../domain/board-view";
import { BoardScenes } from "./BoardScenes";
import { BoardThings, type DeleteControls } from "./BoardThings";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

const card = (over: Partial<PinCard> & { pinId: string }): PinCard => ({
  element: { id: `e-${over.pinId}`, ownerId: "p1", label: "Teal mug", faceFlag: false, imageUrl: `/img/${over.pinId}` },
  status: "pinned",
  ownerName: "Robin",
  ownerId: "p1",
  ...over,
});

const deletion: DeleteControls = {
  confirmElementId: null,
  errorElementId: null,
  deletingElementId: null,
  onAsk: () => {},
  onConfirm: () => {},
  onCancel: () => {},
};

const noop = () => {};

describe("board things grid (PIN-98)", () => {
  const cards = [
    card({ pinId: "mine" }),
    card({ pinId: "theirs", ownerId: "p2", ownerName: "Sam" }),
    card({ pinId: "cand", status: "candidate" }),
  ];

  it("makes pinned things pick toggles and leaves candidates out of the grid (PIN-122)", () => {
    const out = html(
      h(BoardThings, { cards, count: 2, meId: "p1", picking: false, pickNumbers: new Map(), onTapPin: noop, deletion }),
    );
    expect(out.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(out.match(/data-pin-id=/g)).toHaveLength(2);
    expect(out).not.toContain('data-pin-id="cand"');
    expect(out).not.toContain("Not pinned yet");
    expect(out).toContain("Sam");
  });

  it("offers More only on my own things, and not while picking", () => {
    const rest = html(
      h(BoardThings, { cards, count: 2, meId: "p1", picking: false, pickNumbers: new Map(), onTapPin: noop, deletion }),
    );
    expect(rest.match(/More for Teal mug/g)?.length).toBe(2); // aria-label + title, on my pinned thing
    const picking = html(
      h(BoardThings, { cards, count: 2, meId: "p1", picking: true, pickNumbers: new Map([["theirs", 1]]), onTapPin: noop, deletion }),
    );
    expect(picking).not.toContain("More for");
    expect(picking).toContain('data-state="picked"');
    expect(picking).toContain("picked 1");
  });

  it("shows no More to someone who has not joined", () => {
    const out = html(
      h(BoardThings, { cards, count: 2, meId: null, picking: false, pickNumbers: new Map(), onTapPin: noop, deletion }),
    );
    expect(out).not.toContain("More for");
  });
});

describe("board scenes strip (PIN-98)", () => {
  it("replaces an empty strip with one quiet line", () => {
    const out = html(h(BoardScenes, { slots: [], count: 0 }));
    expect(out).toContain("No scenes yet");
    expect(out).not.toContain("pn-prints");
  });

  it("gives a failed attempt both ways out and a refusal only Change idea", () => {
    const failed = html(
      h(BoardScenes, {
        count: 0,
        slots: [{ type: "problem", ratio: "2 / 3", id: "s1", idea: "A picnic", line: "That scene didn't develop.", onChangeIdea: noop, onTryAgain: noop }],
      }),
    );
    expect(failed).toContain("Change idea");
    expect(failed).toContain("Try again");
    const refused = html(
      h(BoardScenes, {
        count: 0,
        slots: [{ type: "problem", ratio: "2 / 3", id: "s1", idea: "A picnic", line: "Try a different idea.", onChangeIdea: noop }],
      }),
    );
    expect(refused).toContain("Change idea");
    expect(refused).not.toContain("Try again");
  });

  it("numbers prints and shows developing scenes in place", () => {
    const out = html(
      h(BoardScenes, {
        count: 1,
        slots: [
          { type: "developing", ratio: "1024 / 1536", id: "d1", stickers: [{ src: "/e1" }], idea: "On the moon", startedAt: null },
          {
            type: "print",
            ratio: "1280 / 1920",
            id: "s1",
            src: "/s1",
            alt: "A picnic, with Robin's teal mug",
            idea: "A picnic",
            credits: [{ thing: "teal mug", owner: { id: "p1", name: "Robin" }, src: "/e1" }],
            kind: "collage",
            remixOf: null,
            number: 1,
            onShare: noop,
            sharing: false,
          },
        ],
      }),
    );
    expect(out).toContain("Developing");
    expect(out).toContain("Nº 01");
    expect(out).toContain("Collage");
    expect(out).toContain("teal mug");
    // PIN-129: each frame takes its slot's shape; the item carries it for the strip width.
    expect(out).toContain('style="--print-ratio:1024 / 1536"');
    expect(out).toContain("aspect-ratio:1024 / 1536");
    expect(out).toContain('style="--print-ratio:1280 / 1920"');
    expect(out).toContain("aspect-ratio:1280 / 1920");
    expect(out).not.toContain("4 / 3");
  });

  it("shows a remix's nine credits as one compact row, not a pill per thing (PIN-130)", () => {
    const names = ["teal mug", "rubber duck", "succulent", "alarm clock", "book stack", "red sneakers", "straw hat", "black cat", "orange cat"];
    const out = html(
      h(BoardScenes, {
        count: 1,
        slots: [
          {
            type: "print",
            ratio: "2 / 3",
            id: "s9",
            src: "/s9",
            alt: "A picnic",
            idea: "A picnic",
            credits: names.map((thing, i) => ({ thing, owner: { id: "p1", name: "Robin" }, src: `/e${i}` })),
            kind: "remix",
            remixOf: { title: "A tiny picnic", owner: "Jo" },
            number: 9,
            onRemix: noop,
            onShare: noop,
            sharing: false,
          },
        ],
      }),
    );
    expect(out).toContain("pn-credit-compact");
    expect(out).toContain(">+4<");
    expect(out).toContain("Made from teal mug, rubber duck, succulent, alarm clock, book stack, red sneakers, straw hat, black cat and orange cat");
    expect(out).toContain("Remix of <b>A tiny picnic</b> by Jo");
    expect(out).not.toContain("pn-credit-item");
    // Nothing in the credits is a tab stop; the only buttons are the print's own (Remix, Share).
    expect(out.match(/<button/g)).toHaveLength(2);
  });
});
