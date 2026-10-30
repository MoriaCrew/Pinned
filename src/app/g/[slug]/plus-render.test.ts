import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PinCard } from "../../../domain/board-view";
import type { PlusView } from "../../../domain/plus";
import { initialLookFlow, type LookFlowState } from "../../../domain/plus-ui";
import { PlusSheet } from "../../../ui";
import { BoardThings, type DeleteControls } from "./BoardThings";
import { ChangeLookSheet } from "./ChangeLookSheet";
import { PlusFlow, type LookFlow } from "./PlusFlow";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const noop = () => {};

const priceLabels = { board: "$3.99", host: "$4.99/month" };
const plusView = (over: Partial<PlusView> = {}): PlusView => ({ active: false, mode: "mock", priceLabels, ...over });

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
    choosePlan: noop,
    getPlus: noop,
    dismissNotice: noop,
  };
}

const flowProps = { boardSkin: "paper" as const, sample: ["/e1", "/e2"], foilSrc: "/e1", aboveDock: true };
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

  it("labels the mock checkout a demo, with the Policy prices", () => {
    const out = html(
      h(PlusFlow, { look: flow({ tryOn: "marigold", sheet: "plus" }, "marigold"), plus: plusView(), ...flowProps }),
    );
    expect(out).toContain("Get Plus · $3.99");
    expect(out).toContain("$4.99/month");
    expect(out).toContain("Demo checkout. Nothing is charged.");
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

describe("Plus sheet radio groups (kit fix)", () => {
  it("never shares a plan radio name between two sheets", () => {
    const sheet = () => h(PlusSheet, { plan: "board", onPlanChange: noop, prices: priceLabels, available: true });
    const out = html(h("div", null, sheet(), sheet()));
    const names = [...new Set([...out.matchAll(/type="radio" name="([^"]+)"/g)].map((match) => match[1]))];
    expect(names).toHaveLength(2);
  });
});
