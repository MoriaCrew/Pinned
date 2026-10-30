import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BoardHeader,
  Developing,
  Dock,
  Icon,
  ICON_NAMES,
  Menu,
  Pin,
  PlusSheet,
  SceneCard,
  SkinPicker,
  Sticker,
  boardMetaLine,
  pickedCountLabel,
} from "./index";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

describe("UI kit helpers (PIN-97)", () => {
  it("writes the board meta line with singular and plural counts", () => {
    expect(boardMetaLine({ people: 6, things: 14, scenes: 1 })).toBe("6 people · 14 things · 1 scene");
    expect(boardMetaLine({ people: 1 })).toBe("1 person");
    expect(boardMetaLine({})).toBe("");
  });

  it("announces picking progress", () => {
    expect(pickedCountLabel(2, 4)).toBe("2 of 4 picked");
  });
});

describe("UI kit components (PIN-97)", () => {
  it("ships 22 icons, decorative unless titled", () => {
    expect(ICON_NAMES).toHaveLength(22);
    expect(ICON_NAMES).toContain("mic");
    expect(html(h(Icon, { name: "camera" }))).toContain('aria-hidden="true"');
    expect(html(h(Icon, { name: "share", title: "Share" }))).toContain('aria-label="Share"');
  });

  it("gives a sticker its seeded tilt and a picked number badge", () => {
    const rest = html(h(Sticker, { src: "/a.webp", seed: "teal-mug" }));
    expect(rest).toContain('data-state="rest"');
    expect(rest).toMatch(/--t:-?\d/);
    const picked = html(h(Sticker, { src: "/a.webp", seed: "x", state: "picked", pickIndex: 2 }));
    expect(picked).toContain("pn-sticker-badge");
    expect(picked).toContain(">2<");
  });

  it("makes a pickable pin a pressed button with a full spoken label", () => {
    const markup = html(
      h(Pin, {
        src: "/a.webp",
        label: "Teal mug",
        owner: { id: "p1", name: "Robin" },
        state: "picked",
        pickIndex: 1,
        onToggle: () => {},
      }),
    );
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Robin&#x27;s Teal mug, picked 1"');
  });

  it("keeps add-sheet pins pressed at rest and unpressed when left out", () => {
    const kept = html(h(Pin, { src: "/a.webp", label: "Duck", onToggle: () => {}, pressedWhenRest: true }));
    expect(kept).toContain('aria-pressed="true"');
    const dropped = html(h(Pin, { src: "/a.webp", label: "Duck", state: "dropped", onToggle: () => {}, pressedWhenRest: true }));
    expect(dropped).toContain('aria-pressed="false"');
    expect(dropped).toContain("left out");
  });

  it("renders the picking tray with one slot per Policy max and disables Next when empty", () => {
    const markup = html(h(Dock, { mode: "picking", picked: [], max: 4 }));
    expect(markup.match(/pn-tray-slot/g)).toHaveLength(4);
    expect(markup).toContain("0 of 4 picked");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Next/);
  });

  it("puts the board name in an h1 with the meta line", () => {
    const markup = html(h(BoardHeader, { title: "Mia's 7th birthday", counts: { people: 2, things: 3 } }));
    expect(markup).toContain("<h1");
    expect(markup).toContain("2 people · 3 things");
  });

  it("tags collages and remixes, and numbers prints", () => {
    expect(html(h(SceneCard, { src: "/s.webp", kind: "collage", number: 3 }))).toContain("Collage");
    expect(html(h(SceneCard, { src: "/s.webp", kind: "remix" }))).toContain("Remix");
    expect(html(h(SceneCard, { src: "/s.webp", number: 3 }))).toContain("Nº 03");
  });

  it("makes the developing card a polite live region", () => {
    const markup = html(h(Developing, { stickers: [{ src: "/a.webp" }], idea: "A picnic" }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });

  it("shows Plus and For you on skin options, and the skin on each mini board", () => {
    const markup = html(
      h(SkinPicker, {
        skins: [{ id: "paper" }, { id: "zine", suggested: true }, { id: "darkroom", locked: true }],
        value: "zine",
        onChange: () => {},
      }),
    );
    expect(markup).toContain('data-theme="darkroom"');
    expect(markup).toContain("For you");
    expect((markup.match(/>Plus</g) ?? []).length).toBe(1);
  });

  it("never offers a purchase when billing is off", () => {
    const off = html(
      h(PlusSheet, { plan: "board", onPlanChange: () => {}, prices: { board: "$3.99", host: "$4.99" }, available: false, layer: "none" }),
    );
    expect(off).toContain("Coming soon");
    expect(off).not.toContain("Get Plus");
    const on = html(
      h(PlusSheet, { plan: "host", onPlanChange: () => {}, prices: { board: "$3.99", host: "$4.99" }, available: true, layer: "none" }),
    );
    expect(on).toContain("Get Plus · $4.99");
    // Perks that aren't built yet say so.
    expect((on.match(/pn-perk-soon/g) ?? []).length).toBe(2);
  });
});

describe("SceneCard body (PIN-100)", () => {
  it("drops the print body when there is nothing to put in it", () => {
    expect(html(h(SceneCard, { src: "/s.webp" }))).not.toContain("pn-print-body");
    expect(html(h(SceneCard, { src: "/s.webp", idea: "A picnic" }))).toContain("pn-print-body");
  });
});

describe("SceneCard print paper (PIN-128)", () => {
  // The frame holds the picture only, so it has no nested div to stop the lazy match early.
  const frameOf = (markup: string) => markup.match(/<div class="pn-print-frame"[^>]*>[^]*?<\/div>/)?.[0] ?? "";
  const metaOf = (markup: string) => markup.match(/<div class="pn-print-meta">[^]*?<\/div>/)?.[0] ?? "";

  it("puts the Remix tag and the number on the paper under the picture, not on it", () => {
    const markup = html(h(SceneCard, { src: "/s.webp", idea: "A picnic", kind: "remix", number: 5 }));
    const frame = frameOf(markup);
    expect(frame).toContain("<img");
    expect(frame).not.toContain("Remix");
    expect(frame).not.toContain("pn-tag");
    expect(frame).not.toContain("pn-print-no");
    expect(frame).not.toContain("Nº");
    const meta = metaOf(markup);
    expect(meta).toContain("pn-tag-mark");
    expect(meta).toContain("Remix");
    expect(meta).toContain("Nº 05");
    expect(meta.indexOf("Remix")).toBeLessThan(meta.indexOf("Nº 05"));
    // Picture, then the row, then the idea.
    expect(markup.indexOf("pn-print-frame")).toBeLessThan(markup.indexOf("pn-print-meta"));
    expect(markup.indexOf("pn-print-meta")).toBeLessThan(markup.indexOf("pn-print-body"));
  });

  it("does the same for a collage, and for a number with no tag", () => {
    const collage = html(h(SceneCard, { src: "/s.webp", kind: "collage", number: 2 }));
    expect(frameOf(collage)).not.toContain("Collage");
    expect(metaOf(collage)).toContain("pn-tag-ink");
    expect(metaOf(collage)).toContain("Collage");
    const plain = html(h(SceneCard, { src: "/s.webp", number: 7 }));
    expect(frameOf(plain)).not.toContain("Nº");
    expect(metaOf(plain)).toContain("Nº 07");
    expect(metaOf(plain)).not.toContain("pn-tag");
  });

  it("adds no row when there is neither a tag nor a number, and leaves Developing with its own status tag", () => {
    expect(html(h(SceneCard, { src: "/s.webp", idea: "A picnic" }))).not.toContain("pn-print-meta");
    const developing = html(h(Developing, { stickers: [{ src: "/a.webp" }], idea: "A picnic" }));
    expect(developing).not.toContain("pn-print-meta");
    expect(developing).toContain("pn-develop-status");
    expect(developing).toContain("Developing");
  });
});

describe("BoardHeader with the you button (PIN-120)", () => {
  const people = [
    { id: "p2", name: "Sam" },
    { id: "p3", name: "Ana Ruiz" },
  ];

  it("keeps the top row to wordmark, Share and you, and starts the meta line with a small people stack", () => {
    const markup = html(
      h(BoardHeader, {
        title: "Mia's 7th birthday",
        people,
        peopleLabel: "Also here: Sam, Ana Ruiz",
        counts: { people: 3, things: 5, scenes: 2 },
        onShare: () => {},
        homeHref: "/",
        you: h("button", { type: "button", className: "test-you" }, "R"),
      }),
    );
    const row = markup.match(/<div class="pn-head-row">[^]*?<\/div><\/div>/)?.[0] ?? "";
    expect(row).toContain('aria-label="Share board link"');
    expect(row).toContain("test-you");
    expect(row).not.toContain("pn-avatars");
    expect(row.indexOf("Share board link")).toBeLessThan(row.indexOf("test-you"));
    const meta = markup.match(/<p class="pn-board-meta pn-head-meta">[^]*<\/p>/)?.[0] ?? "";
    expect(meta).toMatch(/^<p[^>]*><span class="pn-avatars pn-avatars-sm" role="img" aria-label="Also here: Sam, Ana Ruiz">/);
    expect(meta.match(/pn-avatar pn-avatar-sm/g)).toHaveLength(2);
    expect(meta).toContain(">AR<");
    expect(meta).toContain("<span>3 people · 5 things · 2 scenes</span>");
  });

  it("drops the stack when nobody else is here", () => {
    const markup = html(h(BoardHeader, { title: "Sunday pancakes", people: [], counts: { people: 1, things: 0 } }));
    expect(markup).not.toContain("pn-avatars");
    expect(markup).toContain("1 person · 0 things");
  });

  it("caps the small stack at three with a +n", () => {
    const many = ["A", "B", "C", "D", "E"].map((name, i) => ({ id: `p${i}`, name }));
    const markup = html(h(BoardHeader, { title: "Party", people: many, counts: { people: 6 } }));
    expect(markup.match(/pn-avatar pn-avatar-sm/g)).toHaveLength(3);
    expect(markup).toContain("+2");
  });
});

describe("Menu note (PIN-120)", () => {
  it("shows a quiet line above the items without speaking it twice", () => {
    const markup = html(h(Menu, { label: "You: Sam", note: "You're Sam here", items: [{ label: "Edit name" }] }));
    expect(markup).toContain('aria-label="You: Sam"');
    expect(markup).toMatch(/role="menu"[^>]*><p class="pn-menu-note" aria-hidden="true">You&#x27;re Sam here<\/p><button/);
  });
});

describe("Menu links (PIN-104)", () => {
  it("renders href items as real links and the rest as buttons", () => {
    const markup = html(
      h(Menu, {
        label: "Account",
        items: [
          { label: "My boards", href: "/me/boards" },
          { label: "Sign out", onSelect: () => {} },
        ],
      }),
    );
    const link = markup.match(/<a [^>]*>/)?.[0] ?? "";
    expect(link).toContain('href="/me/boards"');
    expect(link).toContain('role="menuitem"');
    expect(markup).toMatch(/<button[^>]*role="menuitem"[^>]*>Sign out/);
  });
});
