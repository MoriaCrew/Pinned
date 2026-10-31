import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PinCard } from "../../../domain/board-view";
import { t } from "../../../i18n";
import { BoardScenes, type PrintSlot } from "./BoardScenes";
import { BoardThings, pinMenuItems, type DeleteControls } from "./BoardThings";
import { SceneViewer } from "./SceneViewer";
import styles from "./board.module.css";

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

  it("lists Rename above Delete in my More menu, and Delete alone when the board cannot rename (PIN-157)", () => {
    const items = pinMenuItems("en", { onRename: noop, onDelete: noop });
    expect(items.map((item) => item.label)).toEqual(["Rename", "Delete"]);
    expect(items.map((item) => "danger" in item && item.danger === true)).toEqual([false, true]);
    expect(pinMenuItems("en", { onDelete: noop }).map((item) => item.label)).toEqual(["Delete"]);
    const mine = html(
      h(BoardThings, { cards, count: 2, meId: "p1", picking: false, pickNumbers: new Map(), onTapPin: noop, deletion, onRename: noop }),
    );
    expect(mine.match(/More for Teal mug/g)?.length).toBe(2); // the menu itself starts closed
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

  it("puts a Get Plus action first on a problem card when the pool ran dry (PIN-183)", () => {
    const out = html(
      h(BoardScenes, {
        count: 0,
        slots: [
          {
            type: "problem",
            ratio: "2 / 3",
            id: "s1",
            idea: "A picnic",
            line: "This board is out of creations. Get Plus to keep going.",
            action: { label: "Get Plus", onSelect: noop },
            onChangeIdea: noop,
            onTryAgain: noop,
          },
        ],
      }),
    );
    expect(out).toContain("This board is out of creations. Get Plus to keep going.");
    // The invitation is announced as a status, not an error.
    expect(out).toContain('role="status">This board is out of creations.');
    expect(out).not.toContain('role="alert"');
    expect(out).toMatch(/pn-btn-primary[^>]*>Get Plus<\/button>/);
    expect(out.indexOf("Get Plus</button>")).toBeLessThan(out.indexOf("Change idea"));
    expect(out).toContain("Try again");
    // Without an action the card is as before.
    const plain = html(
      h(BoardScenes, {
        count: 0,
        slots: [{ type: "problem", ratio: "2 / 3", id: "s1", idea: "A picnic", line: "x", onChangeIdea: noop }],
      }),
    );
    expect(plain).not.toContain("Get Plus");
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
            previewSrc: "/s1?size=preview",
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

  it("puts the budget-collage line under a collage print, after the actions (PIN-180)", () => {
    const out = html(
      h(BoardScenes, {
        count: 1,
        slots: [
          {
            type: "print",
            ratio: "2 / 3",
            id: "s1",
            src: "/s1",
            previewSrc: "/s1?size=preview",
            alt: "A picnic",
            idea: "A picnic",
            credits: [],
            kind: "collage",
            remixOf: null,
            number: 1,
            onShare: noop,
            sharing: false,
            footer: h("p", { className: styles.collageNote }, t("en", "makes.collageBudget")),
          },
        ],
      }),
    );
    expect(out).toContain("AI was busy, so this one is a collage. No creation was used.");
    expect(out).toContain(`class="${styles.collageNote}"`);
    expect(out.indexOf("pn-print-actions")).toBeLessThan(out.indexOf(styles.collageNote));
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
            previewSrc: "/s9?size=preview",
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

describe("scene viewer (PIN-131)", () => {
  const names = ["teal mug", "rubber duck", "succulent", "alarm clock", "book stack", "red sneakers", "straw hat"];
  const remix: PrintSlot = {
    type: "print",
    ratio: "2 / 3",
    id: "s7",
    src: "/api/boards/b/scenes/s7/image",
    previewSrc: "/api/boards/b/scenes/s7/image?size=preview",
    alt: "A picnic, with Robin's teal mug",
    idea: "A picnic",
    credits: names.map((thing, i) => ({ thing, owner: { id: "p1", name: "Robin" }, src: `/e${i}` })),
    kind: "remix",
    remixOf: { title: "A tiny picnic", owner: "Jo" },
    onShare: noop,
    sharing: false,
  };
  const viewer = (over: Partial<Parameters<typeof SceneViewer>[0]> = {}) =>
    html(h(SceneViewer, { slot: remix, onClose: noop, onStep: noop, onRemix: noop, ...over }));

  it("is a modal dialog named by the idea", () => {
    const out = viewer();
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    const labelledBy = out.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(out).toContain(`id="${labelledBy}">“A picnic”</h2>`);
  });

  it("shows the full image, contained and never cropped", () => {
    const out = viewer();
    expect(out).toContain('src="/api/boards/b/scenes/s7/image" alt="A picnic, with Robin&#x27;s teal mug"');
    // Not in a print frame (those cover their shape); the stage contains it.
    expect(out).not.toContain("pn-print-frame");
    const css = readFileSync(path.join(process.cwd(), "src/app/g/[slug]/board.module.css"), "utf8");
    expect(css).toMatch(/\.viewerStage img \{[^}]*object-fit: contain;/);
    expect(css).toMatch(/\.viewerStage \{[^}]*touch-action: pinch-zoom;/);
  });

  it("lists every credit in full with the remix line", () => {
    const out = viewer();
    expect(out).not.toContain("pn-credit-compact");
    expect(out.match(/class="pn-credit-item"/g)).toHaveLength(names.length);
    expect(out).toContain("straw hat");
    expect(out).toContain("Remix of <b>A tiny picnic</b> by Jo");
  });

  it("scrolls only the credits when the panel is full, so the idea, Close and Share stay in view", () => {
    expect(viewer()).toContain(`class="pn-credit ${styles.viewerCredits}"`);
    const css = readFileSync(path.join(process.cwd(), "src/app/g/[slug]/board.module.css"), "utf8");
    expect(css).toMatch(/\.viewer > \.viewerPanel \{[^}]*display: flex;[^}]*flex-direction: column;/);
    expect(css).toMatch(/\.viewerCredits \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
    expect(css).not.toMatch(/\.viewerPanel \{[^}]*overflow-y/);
    // The 55% cap must beat the panel's content-based flex minimum.
    expect(css).toMatch(/\.viewerPanel \{[^}]*min-height: 0;[^}]*max-height: 55%;/);
  });

  it("puts Share first, then Remix, and More only when it has items", () => {
    const out = viewer();
    expect(out).toMatch(/pn-btn-primary[^>]*>.*Share<\/button>.*Remix<\/button>/);
    expect(out).toContain('aria-label="Close"');
    expect(out).not.toContain('aria-label="More"');
    expect(viewer({ onRemix: undefined })).not.toContain("Remix</button>");
    expect(viewer({ more: [{ label: "Delete", onSelect: noop, danger: true }] })).toContain('aria-label="More"');
    expect(viewer({ slot: { ...remix, sharing: true } })).toMatch(/disabled=""[^>]*>.*Share<\/button>/);
  });

  it("asks in the actions row's place, never over the idea and Close, and keeps the error line (PIN-143)", () => {
    const confirmDelete = { deleting: false, error: null, onConfirm: noop, onKeep: noop };
    const more = [{ label: "Delete", onSelect: noop, danger: true }];
    const asked = viewer({ more, confirmDelete });
    const line = "Delete this scene? It&#x27;s gone for everyone on this board.";
    expect(asked).toContain(`class="${styles.viewerConfirm}" role="group"`);
    expect(asked).toMatch(/>Delete<\/button>.*>Keep<\/button>/);
    // In the panel's flow after the credits; the header keeps Close; no popover, no Share/More row.
    expect(asked.indexOf(line)).toBeGreaterThan(asked.indexOf(styles.viewerCredits));
    expect(asked).toContain('aria-label="Close"');
    expect(asked).not.toContain("pn-menu");
    expect(asked).not.toContain("Share</button>");
    expect(asked).not.toContain('aria-label="More"');
    expect(asked).not.toContain('role="alert"');
    const failed = viewer({ more, confirmDelete: { ...confirmDelete, error: "Couldn't delete. Try again." } });
    expect(failed).toContain('role="alert">Couldn&#x27;t delete. Try again.</p>');
    const busy = viewer({ more, confirmDelete: { ...confirmDelete, deleting: true } });
    expect(busy).toMatch(/disabled=""[^>]*>Deleting…<\/button>/);
    expect(busy).toMatch(/disabled=""[^>]*>Keep<\/button>/);
    expect(viewer({ more })).not.toContain("Delete this scene?");
    const css = readFileSync(path.join(process.cwd(), "src/app/g/[slug]/board.module.css"), "utf8");
    expect(css).not.toMatch(/\.viewerConfirm \{[^}]*position:/);
  });

  it("shows Remix of a deleted scene in the viewer's credits", () => {
    expect(viewer({ slot: { ...remix, remixOf: { deleted: true } } })).toContain("Remix of a deleted scene");
  });

  it("credits Muse Image on AI scenes and remixes only, never on a collage (PIN-222)", () => {
    const caption = `<p class="${styles.viewerComposed}">Composed by Muse Image</p>`;
    expect(viewer({ slot: { ...remix, kind: "scene", remixOf: null } })).toContain(caption);
    expect(viewer()).toContain(caption);
    expect(viewer({ slot: { ...remix, kind: "collage" } })).not.toContain("Composed by Muse Image");
    // It sits between the credits and the actions, and stays through the delete confirm.
    const out = viewer();
    expect(out.indexOf(styles.viewerComposed ?? "")).toBeGreaterThan(out.indexOf(styles.viewerCredits ?? ""));
    expect(out.indexOf(styles.viewerComposed ?? "")).toBeLessThan(out.indexOf("pn-print-actions"));
  });

  it("lets the Scenes heading take focus when a delete leaves no print to return to (PIN-143)", () => {
    expect(html(h(BoardScenes, { count: 0, slots: [] }))).toContain('<h2 class="pn-section-title" id="board-scenes" tabindex="-1">');
  });

  it("makes the print's picture and credits row open the viewer", () => {
    const out = html(h(BoardScenes, { count: 1, slots: [{ ...remix, onOpen: noop }] }));
    expect(out).toContain('data-scene-id="s7"');
    expect(out).toMatch(/<button type="button" class="pn-print-open" aria-label="A picnic" aria-haspopup="dialog"><div class="pn-print-frame"/);
    expect(out).toMatch(/class="pn-credit-row pn-credit-open" aria-label="Made from [^"]+" aria-haspopup="dialog"/);
  });

  it("the strip loads the phone-sized preview; the viewer the full image (PIN-133)", () => {
    const strip = html(h(BoardScenes, { count: 1, slots: [remix] }));
    expect(strip).toContain('src="/api/boards/b/scenes/s7/image?size=preview"');
    // No print src ends at /image (the full file): every strip src carries ?size=preview.
    expect(strip).not.toMatch(/src="[^"]*\/image"/);
    expect(viewer()).toContain('src="/api/boards/b/scenes/s7/image"');
    expect(viewer()).not.toContain("size=preview");
  });
});
