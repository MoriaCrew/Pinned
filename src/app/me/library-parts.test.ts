import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MyBoardCard } from "../../domain/my-boards";
import type { MyPinCard } from "../../domain/my-pins";
import en from "../../i18n/messages/en.json";
import { BoardCards, LibraryEmpty, PinLibrary } from "./LibraryParts";

// Each My boards card's More menu refreshes the page after a remove (PIN-166).
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

const board = (over: Partial<MyBoardCard>): MyBoardCard => ({
  slug: "slug-one",
  title: "Mia's 7th birthday",
  themeId: null,
  themeLabel: null,
  themeMotif: null,
  plus: false,
  myPinCount: 3,
  latestSceneImageUrl: null,
  lastActivityAt: Date.UTC(2026, 9, 29, 12),
  claimedAt: 1,
  ...over,
});

describe("My boards cards (PIN-104)", () => {
  it("draws each board in its own skin and maps first-generation themes", () => {
    const markup = html(
      h(BoardCards, { locale: "en",
        boards: [
          board({ slug: "a", themeId: "zine" }),
          board({ slug: "b", themeId: "gran" }),
          board({ slug: "c", themeId: null }),
        ],
      }),
    );
    expect(markup).toContain('data-theme="zine"');
    expect(markup).toContain('data-theme="cork"');
    expect(markup).toContain('data-theme="paper"');
    expect(markup).toContain('href="/g/a"');
  });

  it("tags a board that has Plus, and only that one (PIN-183)", () => {
    const out = html(h(BoardCards, { locale: "en", boards: [board({ slug: "a", plus: true }), board({ slug: "b" })] }));
    expect(out.match(/pn-lib-board-plus/g)).toHaveLength(1);
    expect(out).toMatch(/pn-tag pn-tag-outline pn-lib-board-plus">Plus</);
  });

  it("shows the latest scene as a print, or ghost outlines when there is none", () => {
    const withScene = html(h(BoardCards, { locale: "en", boards: [board({ latestSceneImageUrl: "/api/boards/s/scenes/1/image" })] }));
    expect(withScene).toContain("pn-lib-board-print");
    expect(withScene).toContain('src="/api/boards/s/scenes/1/image"');
    const without = html(h(BoardCards, { locale: "en", boards: [board({})] }));
    expect(without).toContain("pn-lib-board-ghosts");
    expect(without).not.toContain("<img");
  });

  it("gives each card a closed More menu button beside the link, named for the board (PIN-166)", () => {
    const markup = html(h(BoardCards, { locale: "en", boards: [board({ title: "Garden swap", themeId: "zine" })] }));
    expect(markup).toContain('aria-label="More for Garden swap"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('role="menu"');
    // A sibling of the link (never nested in it), in the card's skin.
    expect(markup).toMatch(/<\/a><span class="pn-lib-board-more" data-theme="zine"><button/);
  });

  it("sets the counts in mono lines", () => {
    const markup = html(h(BoardCards, { locale: "en", boards: [board({ myPinCount: 1 })] }));
    expect(markup).toContain("1 thing of yours");
    expect(markup).toContain("Oct 29");
  });
});

describe("My pins library (PIN-104)", () => {
  const card = (elementId: string, label: string): MyPinCard => ({
    elementId,
    label,
    description: "",
    faceFlag: false,
    sourceBoardTitle: "Sam's 30th",
    imageUrl: `/api/me/elements/${elementId}/image?kind=cutout`,
    createdAt: 1,
  });

  it("labels every pin with its source board's title", () => {
    const markup = html(h(PinLibrary, { locale: "en", cards: [card("e1", "Teal mug")], boardSlug: null }));
    expect(markup).toContain("Teal mug");
    expect(markup).toContain("From Sam&#x27;s 30th");
    expect(markup).not.toContain("pn-lib-pin-btn");
    expect(markup).not.toContain("data-pinnable");
  });

  it("adds a spoken Pin here button per pin only with a board context", () => {
    const markup = html(h(PinLibrary, { locale: "en", cards: [card("e1", "Teal mug"), card("e2", "Duck")], boardSlug: "slug-one" }));
    expect(markup).toContain("data-pinnable");
    expect(markup.match(/pn-lib-pin-btn/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Pin here: Teal mug"');
  });
});

describe("Library empty states (PIN-104)", () => {
  it("is one heading, one line and the action", () => {
    const markup = html(h(LibraryEmpty, { title: "No boards yet", body: "Pin something." }, h("a", { href: "/new" }, "Start a board")));
    expect(markup).toContain("<h2");
    expect(markup).toContain("No boards yet");
    expect(markup).toContain('href="/new"');
    expect(html(h(LibraryEmpty, { title: "Nothing pinned here.", headingLevel: 1 }))).toContain("<h1");
  });
});

describe("Strings owned by the landing and library screens (PIN-104)", () => {
  it("carry no emoji", () => {
    const emoji = /\p{Extended_Pictographic}/u;
    const owned = /^(landing|footer|myBoards|myPins|notFound)\.|^auth\.(?!nudge)/;
    for (const [key, value] of Object.entries(en)) {
      if (owned.test(key)) expect(value, key).not.toMatch(emoji);
    }
  });

  it("keep button labels at three words or fewer", () => {
    const buttons = [
      "landing.start",
      "landing.demo",
      "landing.another",
      "notFound.home",
      "auth.signIn",
      "myBoards.emptyAction",
      "myPins.emptyAction",
      "myPins.backToBoard",
      "myPins.pinToBoard",
      "myPins.alreadyPinned",
      "myPins.failed",
    ] as const;
    for (const key of buttons) {
      expect(en[key].trim().split(/\s+/).length, key).toBeLessThanOrEqual(3);
    }
  });
});
