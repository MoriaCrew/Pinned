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
  it("ships 20 icons, decorative unless titled", () => {
    expect(ICON_NAMES).toHaveLength(20);
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
  });
});

describe("SceneCard body (PIN-100)", () => {
  it("drops the print body when there is nothing to put in it", () => {
    expect(html(h(SceneCard, { src: "/s.webp" }))).not.toContain("pn-print-body");
    expect(html(h(SceneCard, { src: "/s.webp", idea: "A picnic" }))).toContain("pn-print-body");
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
