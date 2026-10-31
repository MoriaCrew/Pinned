import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BoardHeader,
  COMPACT_CREDIT_SLOTS,
  Composer,
  CreditLine,
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
  compactCreditsName,
  isSubmitKey,
  pickedCountLabel,
  splitCompactCredits,
} from "./index";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

describe("UI kit helpers (PIN-97)", () => {
  it("writes the board meta line with singular and plural counts", () => {
    expect(boardMetaLine({ people: 6, things: 14, scenes: 1 })).toBe("6 people · 14 pins · 1 scene");
    expect(boardMetaLine({ people: 1 })).toBe("1 person");
    expect(boardMetaLine({})).toBe("");
  });

  it("announces picking progress", () => {
    expect(pickedCountLabel(2, 4)).toBe("2 of 4 picked");
  });
});

describe("UI kit components (PIN-97)", () => {
  it("ships 23 icons, decorative unless titled", () => {
    expect(ICON_NAMES).toHaveLength(23);
    expect(ICON_NAMES).toContain("mic");
    expect(ICON_NAMES).toContain("stop");
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
    expect(markup).toContain("2 people · 3 pins");
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
    const pack = { credits: 20, eurCents: 299 };
    const off = html(h(PlusSheet, { pack, plusActive: false, available: false, layer: "none" }));
    expect(off).toContain("Coming soon");
    expect(off).not.toContain("Get Plus");
    const on = html(h(PlusSheet, { pack, plusActive: false, available: true, layer: "none" }));
    expect(on).toContain("Get Plus · €2.99");
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

describe("CreditLine compact (PIN-130)", () => {
  const names = ["teal mug", "rubber duck", "succulent", "alarm clock", "book stack", "red sneakers", "straw hat", "black cat", "orange cat"];
  const credits = (n: number) =>
    names.slice(0, n).map((thing, i) => ({ thing, owner: { id: `p${i}`, name: `Person ${i}` }, src: `/e/${i}.webp` }));
  const count = (markup: string, cls: string) => (markup.match(new RegExp(`class="${cls}"`, "g")) ?? []).length;
  const rowName = (markup: string) => markup.match(/<div class="pn-credit-row" role="img" aria-label="([^"]*)"/)?.[1];

  it("folds what does not fit into a +N tail that takes the last place and never stands for one", () => {
    const things = Array.from({ length: 9 }, (_, i) => i);
    expect(splitCompactCredits(things.slice(0, 1), 6)).toEqual({ shown: [0], more: 0 });
    expect(splitCompactCredits(things.slice(0, 6), 6)).toEqual({ shown: [0, 1, 2, 3, 4, 5], more: 0 });
    expect(splitCompactCredits(things.slice(0, 7), 6)).toEqual({ shown: [0, 1, 2, 3, 4], more: 2 });
    expect(splitCompactCredits(things, 6)).toEqual({ shown: [0, 1, 2, 3, 4], more: 4 });
    expect(splitCompactCredits(things, 3)).toEqual({ shown: [0, 1], more: 7 });
    expect(splitCompactCredits(things, 1)).toEqual({ shown: [], more: 9 });
    expect(splitCompactCredits([], 6)).toEqual({ shown: [], more: 0 });
  });

  it("names every thing, with and between the last two", () => {
    expect(compactCreditsName("Made from", [])).toBe("Made from");
    expect(compactCreditsName("Made from", ["teal mug"])).toBe("Made from teal mug");
    expect(compactCreditsName("Made from", ["teal mug", "rubber duck"])).toBe("Made from teal mug and rubber duck");
    expect(compactCreditsName("Made from", names.slice(0, 3))).toBe("Made from teal mug, rubber duck and succulent");
  });

  it("shows one thing as one sticker, with no tail", () => {
    const markup = html(h(CreditLine, { compact: true, items: credits(1) }));
    expect(count(markup, "pn-credit-dot")).toBe(1);
    expect(markup).not.toContain("pn-credit-more");
    expect(rowName(markup)).toBe("Made from teal mug");
    expect(markup).toContain("Made from</span>");
  });

  it("shows three things as three stickers and names all three", () => {
    const markup = html(h(CreditLine, { compact: true, items: credits(3) }));
    expect(count(markup, "pn-credit-dot")).toBe(3);
    expect(markup).not.toContain("pn-credit-more");
    expect(rowName(markup)).toBe("Made from teal mug, rubber duck and succulent");
  });

  it("shows nine things as a full row ending in +N, and still names all nine", () => {
    const markup = html(h(CreditLine, { compact: true, items: credits(9) }));
    expect(count(markup, "pn-credit-dot")).toBe(COMPACT_CREDIT_SLOTS - 1);
    expect(markup).toContain('<span class="pn-credit-more">+4</span>');
    const name = rowName(markup) ?? "";
    for (const thing of names) expect(name).toContain(thing);
    expect(name.endsWith("black cat and orange cat")).toBe(true);
  });

  it("is a labelled image, not a control, until it is given onOpen", () => {
    const markup = html(h(CreditLine, { compact: true, items: credits(3) }));
    expect(markup).toContain('role="img"');
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("tabindex");
    expect(markup).not.toContain("pn-credit-list");
    expect(markup).not.toContain("pn-credit-item");
    // The stickers are decorative: the row's name is the only place the things are written.
    expect(markup.match(/<img [^>]*alt=""/g)).toHaveLength(3);
  });

  it("turns the whole row into one button with the same name when onOpen is given", () => {
    const markup = html(h(CreditLine, { compact: true, items: credits(9), onOpen: () => {} }));
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain('<button type="button" class="pn-credit-row pn-credit-open" aria-label="Made from teal mug, ');
    expect(markup).not.toContain('role="img"');
    // Label, stickers and +N are all inside that one button.
    const button = markup.match(/<button[^]*<\/button>/)?.[0] ?? "";
    expect(button).toContain("pn-credit-label");
    expect(button).toContain("pn-credit-dot");
    expect(button).toContain("pn-credit-more");
  });

  it("keeps the Remix of line under the row, with or without the owner", () => {
    const markup = html(h(CreditLine, { compact: true, items: credits(9), remixOf: { title: "A tiny picnic", owner: "Jo" } }));
    expect(markup).toContain('<p class="pn-credit-remix">Remix of <b>A tiny picnic</b> by Jo</p>');
    expect(markup.indexOf("pn-credit-row")).toBeLessThan(markup.indexOf("pn-credit-remix"));
    const noOwner = html(h(CreditLine, { compact: true, items: credits(2), remixOf: { title: "A tiny picnic" } }));
    expect(noOwner).toContain("Remix of <b>A tiny picnic</b></p>");
    expect(html(h(CreditLine, { compact: true, items: credits(2) }))).not.toContain("pn-credit-remix");
    // No things left on the board: no empty row, but the remix source still shows.
    const bare = html(h(CreditLine, { compact: true, items: [], remixOf: { title: "A tiny picnic" } }));
    expect(bare).not.toContain("pn-credit-row");
    expect(bare).toContain("Remix of");
  });

  it("says Remix of a deleted scene once the parent is gone (PIN-143)", () => {
    const markup = html(h(CreditLine, { compact: true, items: credits(2), remixOf: { deleted: true } }));
    expect(markup).toContain('<p class="pn-credit-remix">Remix of a deleted scene</p>');
  });

  it("falls back to the owner's avatar, then the thing's initials, when a cut-out is missing", () => {
    const items = [{ thing: "teal mug", owner: { id: "p1", name: "Robin Lee" } }, { thing: "rubber duck" }];
    const markup = html(h(CreditLine, { compact: true, items }));
    expect(markup).not.toContain("<img");
    expect(markup.match(/pn-avatar-lg/g)).toHaveLength(2);
    expect(markup).toContain(">RL<");
    expect(markup).toContain(">RD<");
  });

  it("takes a given label into the name, and leaves the full list as it was", () => {
    expect(rowName(html(h(CreditLine, { compact: true, items: credits(2), label: "Built from" })))).toBe(
      "Built from teal mug and rubber duck",
    );
    const full = html(h(CreditLine, { items: credits(3), onItem: () => {} }));
    expect(full.match(/pn-credit-item/g)).toHaveLength(3);
    expect(full).toContain("Person 0&#x27;s teal mug");
    expect(full).not.toContain("pn-credit-compact");
  });

  it("makes a print carry the compact row, so its credits stay one row for 2, 5 or 9 things", () => {
    const print = (n: number) =>
      html(
        h(SceneCard, {
          src: "/s.webp",
          idea: "A picnic",
          credits: credits(n),
          remixOf: { title: "Sunday", owner: "Jo" },
          onRemix: () => {},
          onShare: () => {},
        }),
      );
    const stickers = { 2: 2, 5: 5, 9: COMPACT_CREDIT_SLOTS - 1 };
    for (const [n, shown] of Object.entries(stickers)) {
      const markup = print(Number(n));
      expect(markup).toContain("pn-credit-compact");
      expect(markup).not.toContain("pn-credit-list");
      expect(markup).not.toContain("pn-credit-item");
      expect(count(markup, "pn-credit-dot")).toBe(shown);
    }
    // The row sits between the idea and the actions, with the remix line before the actions.
    const markup = print(5);
    expect(markup.indexOf("pn-print-idea")).toBeLessThan(markup.indexOf("pn-credit-compact"));
    expect(markup.indexOf("pn-credit-remix")).toBeLessThan(markup.indexOf("pn-print-actions"));
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
    expect(meta).toContain("<span>3 people · 5 pins · 2 scenes</span>");
  });

  it("drops the stack when nobody else is here", () => {
    const markup = html(h(BoardHeader, { title: "Sunday pancakes", people: [], counts: { people: 1, things: 0 } }));
    expect(markup).not.toContain("pn-avatars");
    expect(markup).toContain("1 person · 0 pins");
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

describe("Composer (PIN-216)", () => {
  const composer = (over: Partial<Parameters<typeof Composer>[0]> = {}) =>
    html(
      h(Composer, {
        id: "idea",
        label: "Your idea",
        value: "",
        onChange: () => {},
        submitLabel: "Make it",
        onSubmit: () => {},
        ...over,
      }),
    );

  it("is a labelled one-line field with a labelled send button and a spoken status line", () => {
    const markup = composer({ placeholder: "e.g. a picnic", maxLength: 500 });
    expect(markup).toMatch(/<label class="pn-sr" for="idea">Your idea<\/label>/);
    expect(markup).toMatch(/<textarea[^>]*id="idea"[^>]*rows="1"/);
    expect(markup).toContain('enterKeyHint="send"');
    expect(markup).toMatch(/<button[^>]*pn-btn-primary[^>]*>Make it<\/button>/);
    expect(markup).toMatch(/<span class="pn-sr" role="status"><\/span>/);
    // Nothing under the field until there is an error or the count matters.
    expect(markup).not.toContain("pn-composer-foot");
  });

  it("puts the tool inside the field, covers the field with an overlay, and shows error + count under it", () => {
    const markup = composer({
      tool: h("button", { type: "button" }, "mic"),
      overlay: h("span", null, "0:07 / 0:30"),
      error: "No mic here.",
      count: "450/500",
      submitDisabled: true,
    });
    expect(markup).toMatch(/pn-composer-field.*pn-composer-overlay.*0:07 \/ 0:30.*pn-composer-tool.*mic/);
    expect(markup).toContain("readOnly");
    expect(markup).toMatch(/role="alert">.*No mic here\./);
    expect(markup).toContain('<span class="pn-field-count">450/500</span>');
    expect(markup).toContain('aria-describedby="idea-foot"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Make it/);
  });

  it("sends on Enter only: not Shift+Enter, not while an IME composes", () => {
    expect(isSubmitKey({ key: "Enter", shiftKey: false })).toBe(true);
    expect(isSubmitKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isSubmitKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(isSubmitKey({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
    expect(isSubmitKey({ key: "a", shiftKey: false })).toBe(false);
  });
});
