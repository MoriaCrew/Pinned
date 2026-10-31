import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PinCard } from "../../../domain/board-view";
import type { PlusView } from "../../../domain/plus";
import { chooseLook, initialLookFlow, type LookFlowState } from "../../../domain/plus-ui";
import { LocaleProvider } from "../../../i18n/client";
import { PlusSheet } from "../../../ui";
import { BoardThings, type DeleteControls } from "./BoardThings";
import { ChangeLookSheet } from "./ChangeLookSheet";
import type { MakesFlow } from "./MakesFlow";
import { PlusFlow, type LookFlow } from "./PlusFlow";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const noop = () => {};

const plusView = (over: Partial<PlusView> = {}): PlusView => ({ active: false, mode: "mock", ...over });
/** `Policy.credits.packs[0]`: the one purchase, 20 creations for 299 cents. */
const PACK = { lookupKey: "pinneds_plus_20", credits: 20, eurCents: 299 };

function flow(state: Partial<LookFlowState>, tryOn: LookFlow["tryOn"] = null): LookFlow {
  return {
    state: { ...initialLookFlow, ...state },
    shownSkin: tryOn ?? "paper",
    tryOn,
    openLook: noop,
    closeSheet: noop,
    pickLook: noop,
    keep: noop,
    undo: noop,
    getPlus: async () => "skipped" as const,
    dismissNotice: noop,
  };
}

function makesFlow(over: Partial<MakesFlow> = {}): MakesFlow {
  return {
    canBuy: true,
    sheetOpen: false,
    openSheet: noop,
    closeSheet: noop,
    busy: false,
    error: null,
    unavailable: false,
    buy: noop,
    banner: null,
    dismissBanner: noop,
    ...over,
  };
}

const flowProps = {
  boardSkin: "paper" as const,
  sample: ["/e1", "/e2"],
  foilSrc: "/e1",
  aboveDock: true,
  makes: makesFlow(),
  pack: PACK,
  isHost: true,
};
/** The kit's lock icon (its shackle path). */
const LOCK_ICON = /M8\.5 10\.5V8a3\.5 3\.5 0 0 1 7 0v2\.5/g;

describe("Change look sheet (PIN-111)", () => {
  it("shows every skin, the current one chosen, Plus looks locked without Plus", () => {
    const out = html(
      h(ChangeLookSheet, { boardSkin: "paper", tryOn: null, plus: plusView(), sample: ["/e1"], onPick: noop, onClose: noop }),
    );
    expect(out).toContain("Pick a look");
    expect(out.match(/type="radio"/g)).toHaveLength(7);
    expect(out).toMatch(/checked="" value="paper"/);
    expect(out.match(/>Plus</g)).toHaveLength(3);
    expect(out.match(LOCK_ICON)).toHaveLength(3);
    // Nothing to change yet: the one button waits.
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?Use Paper/);
    expect(out).toContain('src="/e1"');
  });

  it("drops the locks once Plus counts and starts on a try-on", () => {
    const open = html(
      h(ChangeLookSheet, { boardSkin: "paper", tryOn: "marigold", plus: plusView({ active: true }), sample: [], onPick: noop, onClose: noop }),
    );
    expect(open.match(/>Plus</g)).toHaveLength(3);
    expect(open.match(LOCK_ICON)).toBeNull();
    expect(open).toMatch(/checked="" value="marigold"/);
  });
});

describe("foil perk (PIN-111)", () => {
  const card = (pinId: string): PinCard => ({
    element: { id: `e-${pinId}`, ownerId: "p1", label: "Teal mug", faceFlag: false, imageUrl: `/img/${pinId}` },
    status: "pinned",
    ownerName: "Robin",
    ownerId: "p1",
    pinId,
  });
  const deletion: DeleteControls = {
    confirmElementId: null,
    errorElementId: null,
    deletingElementId: null,
    onAsk: noop,
    onConfirm: noop,
    onCancel: noop,
  };
  const props = { cards: [card("a"), card("b")], count: 2, meId: null, picking: false, pickNumbers: new Map(), onTapPin: noop, deletion };

  it("puts foil on the chosen pin only", () => {
    const out = html(h(BoardThings, { ...props, foilPinId: "a" }));
    expect(out.match(/data-foil=""/g)).toHaveLength(1);
    expect(out).toContain("pn-foil");
    expect(html(h(BoardThings, props))).not.toContain("data-foil");
  });
});

describe("Plus flow overlays (PIN-111)", () => {
  it("shows the TryOnBar with Keep it while trying a look on", () => {
    const out = html(h(PlusFlow, { look: flow({ tryOn: "marigold" }, "marigold"), plus: plusView(), ...flowProps }));
    expect(out).toContain("Trying on");
    expect(out).toContain("Marigold");
    expect(out).toContain("Keep it");
  });

  it("hides the TryOnBar while the look is saving", () => {
    const out = html(
      h(PlusFlow, { look: flow({ tryOn: "marigold", applying: "marigold" }, "marigold"), plus: plusView(), ...flowProps }),
    );
    expect(out).not.toContain("Trying on");
  });

  it("sells nothing with billing off: Coming soon, no demo note", () => {
    const out = html(
      h(PlusFlow, { look: flow({ tryOn: "marigold", sheet: "plus" }, "marigold"), plus: plusView({ mode: "off" }), ...flowProps }),
    );
    expect(out).toContain("Coming soon");
    expect(out).toContain("Nothing is charged.");
    expect(out).not.toContain("Get Plus");
    expect(out).not.toContain("Demo checkout");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Coming soon/);
  });

  it("labels the mock checkout a demo, with the Policy pack's price", () => {
    const out = html(
      h(PlusFlow, { look: flow({ tryOn: "marigold", sheet: "plus" }, "marigold"), plus: plusView(), ...flowProps }),
    );
    expect(out).toContain("Get Plus · €2.99");
    expect(out).toContain("Once, for this board.");
    expect(out).toContain("Demo checkout. Nothing is charged.");
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>Get Plus/);
    // The trust note belongs to a real checkout only.
    expect(out).not.toContain("local currency");
    // No plans, no Host plan, no dollars.
    expect(out).not.toContain("Host plan");
    expect(out).not.toContain("$");
    expect(out).not.toContain('type="radio"');
  });

  it("turns an unavailable answer into Coming soon", () => {
    const out = html(
      h(PlusFlow, {
        look: flow({ tryOn: "marigold", sheet: "plus", unavailable: true }, "marigold"),
        plus: plusView(),
        ...flowProps,
      }),
    );
    expect(out).toContain("Coming soon");
    expect(out).not.toContain("Get Plus");
  });

  it("confirms a mock grant as a demo, and keeps errors until dismissed", () => {
    const granted = html(
      h(PlusFlow, { look: flow({ notice: { kind: "granted", skin: "marigold" } }), plus: plusView({ active: true }), ...flowProps }),
    );
    expect(granted).toContain("Board Plus is on. Look changed to Marigold.");
    expect(granted).toContain("Nothing was charged.");
    expect(granted).toContain('role="status"');
    const failed = html(h(PlusFlow, { look: flow({ notice: { kind: "lookFailed" } }), plus: plusView(), ...flowProps }));
    expect(failed).toContain("Couldn&#x27;t change the look. Try again.");
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('aria-label="Close"');
  });

  it("opens the Change look sheet", () => {
    const out = html(h(PlusFlow, { look: flow({ sheet: "look" }), plus: plusView(), ...flowProps }));
    expect(out).toContain("Pick a look");
  });
});

describe("a member who changes the look (PIN-183)", () => {
  const member = { ...flowProps, isHost: false };
  const plusOn = plusView({ active: true, plan: "board", mode: "stripe" });

  it("opens Change look with nothing locked once the board has Plus, and no try-on bar", () => {
    const out = html(h(PlusFlow, { look: flow({ sheet: "look" }), plus: plusOn, ...member }));
    expect(out).toContain("Pick a look");
    expect(out.match(/type="radio"/g)).toHaveLength(7);
    expect(out.match(LOCK_ICON)).toBeNull();
    expect(out).not.toContain("Trying on");
  });

  it("confirms a saved look to the member who changed it", () => {
    const out = html(h(PlusFlow, { look: flow({ notice: { kind: "applied", skin: "zine" } }), plus: plusOn, ...member }));
    expect(out).toContain("Look changed to Zine.");
    expect(out).not.toContain("Trying on");
  });

  it("applies a member's pick directly, even a Plus skin", () => {
    expect(chooseLook("marigold", { boardSkin: "paper", tryOn: null, plus: plusOn })).toEqual({ kind: "apply", skin: "marigold" });
  });
});

describe("the one Plus sheet (PIN-182)", () => {
  const sheet = (over: Partial<Parameters<typeof PlusSheet>[0]> = {}) => html(h(PlusSheet, { pack: PACK, plusActive: false, available: true, layer: "none", ...over }));
  // The kit reads the language from the provider (PIN-194).
  const sheetFr = (over: Partial<Parameters<typeof PlusSheet>[0]> = {}) =>
    html(h(LocaleProvider, { locale: "fr", enabled: ["en", "fr"], cookieMaxAgeSeconds: 1, children: h(PlusSheet, { pack: PACK, plusActive: false, available: true, layer: "none", ...over }) }));
  const at = (out: string, text: string) => {
    const index = out.indexOf(text);
    expect(index, text).toBeGreaterThanOrEqual(0);
    return index;
  };

  it("lists the perks in order, with one CTA priced from the pack and a quiet line", () => {
    const out = sheet();
    expect(out).toContain("Anyone on the board can get Plus. Everyone here gets it.");
    const order = ["+20 creations", "Every skin", "Foil stickers", "Deeper scenes", "Full-size downloads"].map((text) => at(out, text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(out).toContain("For everyone on this board. Photos and scenes.");
    expect(out).toContain("More photos in one scene");
    // The two planned perks say so; nothing else is tagged.
    expect(out.match(/pn-perk-soon/g)).toHaveLength(2);
    expect(out).toContain("Get Plus · €2.99");
    expect(out).toContain("Once, for this board.");
    expect(out.match(/pn-btn-primary/g)).toHaveLength(1);
    expect(out).toContain('role="dialog"');
  });

  it("formats the price and creation count from the Policy pack, whatever it is", () => {
    const out = sheet({ pack: { credits: 7, eurCents: 350 } });
    expect(out).toContain("+7 creations");
    expect(out).toContain("Get Plus · €3.50");
    expect(sheet({ pack: { credits: 1, eurCents: 100 } })).toContain("+1 creation<");
    expect(sheet({ pack: { credits: 1, eurCents: 100 }, plusActive: true })).toContain("Add 1 creation · €1.00");
  });

  it("with Plus on, collapses to the creations line and a Plus is on line, and adds creations", () => {
    const out = sheet({ plusActive: true });
    expect(out).toContain("+20 creations");
    expect(out).toContain("Plus is on");
    expect(out).toContain("Add 20 creations · €2.99");
    expect(out).toContain("Anyone on this board can add creations.");
    expect(out).not.toContain("Every skin");
    expect(out).not.toContain("Foil stickers");
    expect(out).not.toContain("pn-perk-soon");
    expect(out).not.toContain("Once, for this board.");
    expect(out).not.toContain("Get Plus");
  });

  it("says Coming soon and sells nothing when billing is not available", () => {
    const out = sheet({ available: false });
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Coming soon/);
    expect(out).toContain("Payments open after the hackathon. Nothing is charged.");
    expect(out).not.toContain("€2.99");
    expect(out).not.toContain("Once, for this board.");
    // No pack to price is the same: nothing to sell.
    expect(sheet({ pack: null })).toContain("Coming soon");
    expect(sheet({ pack: null })).not.toContain("creations");
  });

  it("locks the button with a reason, and shows busy and error states inline", () => {
    const locked = sheet({ lockedLine: "Only the host can do that." });
    expect(locked).toMatch(/<button[^>]*disabled=""[^>]*>Get Plus · €2.99/);
    expect(locked).toContain("Only the host can do that.");
    expect(locked).not.toContain("Once, for this board.");
    const busy = sheet({ busy: true });
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>Opening checkout/);
    const failed = sheet({ error: "Couldn't open checkout. Try again." });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Couldn&#x27;t open checkout. Try again.");
    expect(sheet()).not.toContain('role="alert"');
  });

  it("shows the one trust line under the button only for a real checkout that can sell", () => {
    const note = "You may be charged in your local currency. Appears as PINNEDS on your statement.";
    expect(sheet({ paymentNote: true })).toContain(note);
    expect(sheet({ paymentNote: true }).match(/local currency/g)).toHaveLength(1);
    expect(sheet()).not.toContain("local currency");
    expect(sheet({ paymentNote: true, available: false })).not.toContain("local currency");
    const fr = sheetFr({ paymentNote: true });
    expect(fr).toContain("Le paiement peut se faire dans votre devise locale. Apparaît sous le nom PINNEDS sur votre relevé.");
  });

  it("renders in French with French prices", () => {
    const out = sheetFr().replace(/[  ]/g, " ");
    expect(out).toContain("Board Plus");
    expect(out).toContain("Obtenir Plus · 2,99 €");
    expect(out).toContain("+20 créations");
    expect(out).toContain("Une seule fois, pour ce tableau.");
    expect(out).toContain("Bientôt");
    expect(sheetFr({ plusActive: true }).replace(/[  ]/g, " ")).toContain("Ajouter 20 créations · 2,99 €");
    expect(sheetFr({ available: false })).toContain("Bientôt disponible");
  });
});

describe("the Plus sheet on the board (PIN-182)", () => {
  const guest = { ...flowProps, isHost: false };
  const open = (over: Partial<Parameters<typeof PlusFlow>[0]>) =>
    html(h(PlusFlow, { look: flow({}), plus: plusView({ mode: "stripe" }), ...flowProps, ...over }));

  it("opens for a guest from the creations indicator, with no try-on bar", () => {
    const out = open({ ...guest, makes: makesFlow({ sheetOpen: true }) });
    expect(out).toContain("Board Plus");
    expect(out).toContain("Get Plus · €2.99");
    expect(out).toContain("You may be charged in your local currency. Appears as PINNEDS on your statement.");
    expect(out).not.toContain("Trying on");
    expect(out).not.toContain("Demo checkout");
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>Get Plus/);
  });

  it("stays closed until something asks for it", () => {
    expect(open({})).not.toContain("Board Plus");
  });

  it("stripe: the credits checkout's busy, error and unavailable answers show on the sheet", () => {
    const sheet = (makes: Partial<MakesFlow>) => open({ makes: makesFlow({ sheetOpen: true, ...makes }) });
    expect(sheet({ busy: true })).toMatch(/<button[^>]*disabled=""[^>]*>Opening checkout/);
    const cap = sheet({ error: "cap" });
    expect(cap).toContain('role="alert"');
    expect(cap).toContain("Too many checkouts are already open");
    expect(sheet({ error: "rate" })).toContain("Too many tries just now");
    expect(sheet({ error: "join" })).toContain("Join this board first");
    expect(sheet({ error: "generic" })).toContain("Couldn&#x27;t open checkout. Try again.");
    const unavailable = sheet({ unavailable: true });
    expect(unavailable).toMatch(/<button[^>]*disabled=""[^>]*>Coming soon/);
    expect(unavailable).toContain("Nothing is charged.");
  });

  it("mock: a guest sees the sheet and the demo note, with the button locked to the host", () => {
    const out = open({ ...guest, plus: plusView({ mode: "mock" }), makes: makesFlow({ sheetOpen: true }) });
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Get Plus · €2.99/);
    expect(out).toContain("Only the board&#x27;s host can do that.");
    expect(out).toContain("Demo checkout. Nothing is charged.");
    // The host's demo button is live.
    const host = open({ plus: plusView({ mode: "mock" }), makes: makesFlow({ sheetOpen: true }) });
    expect(host).not.toMatch(/<button[^>]*disabled=""[^>]*>Get Plus/);
  });

  it("mock with Plus on: the add button is disabled under the demo line, for the host too", () => {
    const plusOn = plusView({ mode: "mock", active: true, plan: "board" });
    for (const isHost of [true, false]) {
      const out = open({ isHost, plus: plusOn, makes: makesFlow({ sheetOpen: true }) });
      expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Add 20 creations · €2.99/);
      // The banner and the line under the button.
      expect(out.match(/Demo checkout\. Nothing is charged\./g)).toHaveLength(2);
      expect(out).not.toContain("Only the board&#x27;s host can do that.");
      expect(out).not.toContain("local currency");
    }
  });

  it("only stripe shows the trust line: not mock, not off", () => {
    const sheetFor = (mode: PlusView["mode"], look = flow({})) =>
      open({ look, plus: plusView({ mode }), makes: makesFlow({ sheetOpen: true }) });
    expect(sheetFor("stripe")).toContain("local currency");
    expect(sheetFor("mock")).not.toContain("local currency");
    expect(sheetFor("off")).not.toContain("local currency");
  });

  it("off: opened by Keep it, it is Coming soon even for the host", () => {
    const out = open({ look: flow({ sheet: "plus", tryOn: "marigold" }, "marigold"), plus: plusView({ mode: "off" }) });
    expect(out).toContain("Coming soon");
    expect(out).not.toContain("Get Plus");
  });

  it("with Plus on, offers more creations", () => {
    const out = open({ plus: plusView({ mode: "stripe", active: true, plan: "board" }), makes: makesFlow({ sheetOpen: true }) });
    expect(out).toContain("Plus is on");
    expect(out).toContain("Add 20 creations · €2.99");
  });
});
