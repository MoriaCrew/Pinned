import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlusView } from "../../../domain/plus";
import { initialLookFlow, type LookFlowState } from "../../../domain/plus-ui";
import { LocaleProvider } from "../../../i18n/client";
import { ChangeLookSheet } from "./ChangeLookSheet";
import type { MakesFlow } from "./MakesFlow";
import { PlusFlow, type LookFlow } from "./PlusFlow";

// PIN-232: skin names read from the visitor's language everywhere a look
// is named, not the English default. Cork, Darkroom and Postcard differ
// between English and French (Marigold and Zine do not, so they prove nothing).
const noop = () => {};
const inFrench = (element: ReactElement) =>
  renderToStaticMarkup(
    h(LocaleProvider, { locale: "fr", enabled: ["en", "fr"], cookieMaxAgeSeconds: 1, children: element }),
  );
const plusView = (over: Partial<PlusView> = {}): PlusView => ({ active: false, mode: "mock", ...over });

describe("Change look sheet in French (PIN-232)", () => {
  const sheet = (over: Partial<Parameters<typeof ChangeLookSheet>[0]>) =>
    h(ChangeLookSheet, { boardSkin: "paper", tryOn: null, plus: plusView(), sample: [], onPick: noop, onClose: noop, ...over });

  it("names the current look on the button", () => {
    const out = inFrench(sheet({}));
    expect(out).toContain("Utilise Papier");
    expect(out).not.toContain("Paper");
  });

  // A static render starts on the look already showing, so the button
  // reads "Utilise …". "Essaie …" (look.try) needs a tap on another Plus
  // look, which has no DOM harness here; it is the same call, checked by
  // hand in the French screenshot.
  it("names the Plus look being tried on", () => {
    const out = inFrench(sheet({ tryOn: "darkroom" }));
    expect(out).toContain("Utilise Chambre noire");
    expect(out).not.toContain("Darkroom");
  });

  it("names a free look chosen as the board's look", () => {
    const out = inFrench(sheet({ boardSkin: "cork", tryOn: null }));
    expect(out).toContain("Utilise Liège");
    expect(out).not.toContain("Cork");
  });
});

describe("Plus flow look notices in French (PIN-232)", () => {
  const flow = (state: Partial<LookFlowState>): LookFlow => ({
    state: { ...initialLookFlow, ...state },
    shownSkin: "paper",
    tryOn: null,
    openLook: noop,
    closeSheet: noop,
    pickLook: noop,
    keep: noop,
    undo: noop,
    getPlus: async () => "skipped" as const,
    dismissNotice: noop,
  });
  const makes: MakesFlow = {
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
  };
  const notice = (state: Partial<LookFlowState>) =>
    inFrench(
      h(PlusFlow, {
        look: flow(state),
        makes,
        boardSkin: "paper",
        plus: plusView(),
        pack: null,
        isHost: true,
        sample: [],
        aboveDock: false,
      }),
    );

  it("names the look that was applied", () => {
    const out = notice({ notice: { kind: "applied", skin: "cork" } });
    expect(out).toContain("Look changé en Liège.");
    expect(out).not.toContain("Cork");
  });

  it("names the look that came with Plus", () => {
    const out = notice({ notice: { kind: "granted", skin: "postcard" } });
    expect(out).toContain("Board Plus est activé. Look changé en Carte postale.");
    expect(out).not.toContain("Postcard");
  });
});
