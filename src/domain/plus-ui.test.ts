import { describe, expect, it } from "vitest";
import {
  activeTryOn,
  canApplyDirectly,
  canBuyPlus,
  chooseLook,
  effectiveSkin,
  foilPinId,
  initialLookFlow,
  keepStep,
  lookFlow,
  lookSample,
  parseTryOn,
  readCheckoutResponse,
  readSkinResponse,
  safeRedirectUrl,
  urlWithoutTryOn,
  type LookFlowEvent,
  type LookFlowState,
} from "./plus-ui";
import { SKINS } from "./skins";

const free = { active: false };
const plus = { active: true };

describe("effective skin (PIN-111)", () => {
  it("shows the host's try-on and the board's skin to everyone else", () => {
    expect(effectiveSkin("paper", "marigold", true)).toBe("marigold");
    expect(effectiveSkin("paper", "marigold", false)).toBe("paper");
    expect(effectiveSkin("paper", null, true)).toBe("paper");
  });

  it("drops a try-on of the skin the board already wears", () => {
    expect(activeTryOn("marigold", "marigold", true)).toBeNull();
    expect(activeTryOn("paper", "darkroom", true)).toBe("darkroom");
    expect(activeTryOn("paper", "darkroom", false)).toBeNull();
  });
});

describe("applying a look", () => {
  it("applies free skins always and Plus skins only while Plus counts", () => {
    for (const skin of SKINS) {
      expect(canApplyDirectly(skin.id, free)).toBe(!skin.plus);
      expect(canApplyDirectly(skin.id, plus)).toBe(true);
    }
    expect(canApplyDirectly("marigold", undefined)).toBe(false);
    expect(canApplyDirectly("zine", null)).toBe(true);
  });

  it("chooses apply, try-on, restore or nothing from the sheet", () => {
    const base = { boardSkin: "paper" as const, tryOn: null, plus: free };
    expect(chooseLook("zine", base)).toEqual({ kind: "apply", skin: "zine" });
    expect(chooseLook("marigold", base)).toEqual({ kind: "tryOn", skin: "marigold" });
    expect(chooseLook("paper", base)).toEqual({ kind: "none" });
    expect(chooseLook("marigold", { ...base, plus })).toEqual({ kind: "apply", skin: "marigold" });
    const trying = { ...base, tryOn: "darkroom" as const };
    expect(chooseLook("darkroom", trying)).toEqual({ kind: "none" });
    expect(chooseLook("paper", trying)).toEqual({ kind: "restore" });
    expect(chooseLook("postcard", trying)).toEqual({ kind: "tryOn", skin: "postcard" });
    expect(chooseLook("cork", trying)).toEqual({ kind: "apply", skin: "cork" });
  });

  it("keeps a try-on directly with Plus, else offers Plus", () => {
    expect(keepStep("marigold", plus)).toBe("apply");
    expect(keepStep("marigold", free)).toBe("offer");
  });

  it("sells Plus only when billing is not off", () => {
    expect(canBuyPlus({ mode: "mock" })).toBe(true);
    expect(canBuyPlus({ mode: "off" })).toBe(false);
    expect(canBuyPlus(undefined)).toBe(false);
  });
});

describe("?tryon= link", () => {
  it("starts a try-on of a Plus skin for the host only", () => {
    expect(parseTryOn("marigold", true, "paper")).toBe("marigold");
    expect(parseTryOn("marigold", false, "paper")).toBeNull();
  });

  it("ignores free skins, the current skin, junk and repeated params", () => {
    expect(parseTryOn("zine", true, "paper")).toBeNull();
    expect(parseTryOn("marigold", true, "marigold")).toBeNull();
    expect(parseTryOn("helpdesk", true, "paper")).toBeNull();
    expect(parseTryOn(["marigold", "postcard"], true, "paper")).toBeNull();
    expect(parseTryOn(undefined, true, "paper")).toBeNull();
  });

  it("strips only tryon from the URL", () => {
    expect(urlWithoutTryOn("https://pinneds.app/g/abc?tryon=marigold")).toBe("/g/abc");
    expect(urlWithoutTryOn("https://pinneds.app/g/abc?x=1&tryon=marigold#top")).toBe("/g/abc?x=1#top");
    expect(urlWithoutTryOn("https://pinneds.app/g/abc?x=1")).toBeNull();
    expect(urlWithoutTryOn("not a url")).toBeNull();
  });
});

describe("Plus perks on the board", () => {
  const cards = [
    { pinId: "c1", status: "candidate", element: { imageUrl: "/c1" } },
    { pinId: "p1", status: "pinned", element: { imageUrl: "/p1" } },
    { pinId: "p2", status: "pinned", element: { imageUrl: "/p2" } },
  ];

  it("puts foil on the first pinned thing only while Plus counts", () => {
    expect(foilPinId(cards, plus)).toBe("p1");
    expect(foilPinId(cards, free)).toBeNull();
    expect(foilPinId([cards[0]], plus)).toBeNull();
  });

  it("samples pinned things only (candidates stay private)", () => {
    expect(lookSample(cards)).toEqual(["/p1", "/p2"]);
  });
});

describe("server answers", () => {
  it("reads PATCH skin", () => {
    expect(readSkinResponse(200, { board: { themeId: "zine" } })).toEqual({ kind: "applied", themeId: "zine" });
    expect(readSkinResponse(402, { error: "x", code: "plus_required" })).toEqual({ kind: "plusRequired" });
    expect(readSkinResponse(402, { error: "x" })).toEqual({ kind: "failed" });
    expect(readSkinResponse(403, { code: "host_only" })).toEqual({ kind: "failed" });
    expect(readSkinResponse(200, null)).toEqual({ kind: "failed" });
  });

  it("reads POST plus", () => {
    const view = { active: true, plan: "board", mode: "mock", priceLabels: { board: "$3.99", host: "$4.99/month" } };
    expect(readCheckoutResponse(200, { status: "granted", plus: view })).toEqual({ kind: "granted", plus: view });
    expect(readCheckoutResponse(200, { status: "granted" })).toEqual({ kind: "granted", plus: null });
    expect(readCheckoutResponse(200, { status: "unavailable" })).toEqual({ kind: "unavailable" });
    expect(readCheckoutResponse(200, { status: "redirect", url: "https://checkout.example/s/1" })).toEqual({
      kind: "redirect",
      url: "https://checkout.example/s/1",
    });
    expect(readCheckoutResponse(429, { status: "granted" })).toEqual({ kind: "failed" });
    expect(readCheckoutResponse(200, { status: "weird" })).toEqual({ kind: "failed" });
  });

  it("follows only https or same-origin redirects", () => {
    expect(safeRedirectUrl("/g/abc?plus=1")).toBe("/g/abc?plus=1");
    expect(safeRedirectUrl("https://checkout.example/x")).toBe("https://checkout.example/x");
    expect(safeRedirectUrl("javascript:alert(1)")).toBeNull();
    expect(safeRedirectUrl("http://checkout.example/x")).toBeNull();
    expect(safeRedirectUrl("//evil.example/x")).toBeNull();
    expect(safeRedirectUrl("/\\evil.example")).toBeNull();
    expect(readCheckoutResponse(200, { status: "redirect", url: "javascript:alert(1)" })).toEqual({ kind: "failed" });
  });
});

describe("look flow reducer", () => {
  const run = (events: LookFlowEvent[], from: LookFlowState = initialLookFlow) => events.reduce(lookFlow, from);

  it("applies a free look optimistically and confirms it", () => {
    const applying = run([{ type: "openLook" }, { type: "applyStart", skin: "zine" }]);
    expect(applying).toMatchObject({ sheet: "none", applying: "zine" });
    expect(lookFlow(applying, { type: "applyDone", skin: "zine" })).toMatchObject({
      applying: null,
      notice: { kind: "applied", skin: "zine" },
    });
    expect(lookFlow(applying, { type: "applyFailed" })).toMatchObject({ applying: null, notice: { kind: "lookFailed" } });
  });

  it("tries on, offers Plus on Keep it, and keeps trying when the sheet closes", () => {
    const offered = run([{ type: "openLook" }, { type: "tryOn", skin: "marigold" }, { type: "offerPlus" }]);
    expect(offered).toMatchObject({ sheet: "plus", tryOn: "marigold" });
    expect(lookFlow(offered, { type: "closeSheet" })).toMatchObject({ sheet: "none", tryOn: "marigold" });
    expect(lookFlow(offered, { type: "endTryOn" })).toMatchObject({ sheet: "none", tryOn: null });
  });

  it("grants, then applies the try-on and says Plus is on", () => {
    const done = run([
      { type: "tryOn", skin: "marigold" },
      { type: "offerPlus" },
      { type: "choosePlan", plan: "host" },
      { type: "checkoutStart" },
      { type: "checkoutGranted" },
      { type: "applyStart", skin: "marigold" },
      { type: "applyDone", skin: "marigold" },
    ]);
    expect(done).toMatchObject({
      sheet: "none",
      tryOn: null,
      plan: "host",
      grantedNow: false,
      notice: { kind: "granted", skin: "marigold" },
    });
  });

  it("holds the sheet open while checking out", () => {
    const busy = run([{ type: "tryOn", skin: "darkroom" }, { type: "offerPlus" }, { type: "checkoutStart" }]);
    expect(lookFlow(busy, { type: "closeSheet" })).toBe(busy);
  });

  it("turns an unavailable checkout into Coming soon and a failure into one line", () => {
    const base = run([{ type: "tryOn", skin: "darkroom" }, { type: "offerPlus" }, { type: "checkoutStart" }]);
    expect(lookFlow(base, { type: "checkoutUnavailable" })).toMatchObject({ sheet: "plus", unavailable: true, checkingOut: false });
    expect(lookFlow(base, { type: "checkoutFailed" })).toMatchObject({
      sheet: "none",
      tryOn: "darkroom",
      notice: { kind: "plusFailed" },
    });
    // Reopening the sheet asks the server again.
    expect(run([{ type: "checkoutUnavailable" }, { type: "closeSheet" }, { type: "offerPlus" }], base).unavailable).toBe(false);
  });

  it("answers a 402 by keeping the look on locally and offering Plus", () => {
    const state = run([{ type: "applyStart", skin: "postcard" }, { type: "plusRequired", skin: "postcard" }]);
    expect(state).toMatchObject({ applying: null, tryOn: "postcard", sheet: "plus" });
  });
});
