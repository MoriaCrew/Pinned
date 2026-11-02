import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocaleProvider } from "../../i18n/client";
import { LanguageLink, LanguageMenu } from "./LanguageMenu";
import { YouView } from "./You";
import type { AuthContextValue } from "./AuthProvider";

const linkOnly: AuthContextValue = {
  enabled: false,
  status: "signedOut",
  user: null,
  signInError: false,
  signIn: async () => {},
  signOut: async () => {},
};
const withLocales = (enabled: ("en" | "fr")[], locale: "en" | "fr", child: ReactElement) =>
  renderToStaticMarkup(h(LocaleProvider, { locale, enabled, cookieMaxAgeSeconds: 1, children: child }));

describe("language list (PIN-191)", () => {
  it("lists each language in its own name, English first, the current one marked", () => {
    const out = withLocales(["en", "fr"], "fr", h(LanguageMenu, { onClose: () => {} }));
    expect(out.indexOf("English")).toBeLessThan(out.indexOf("Français"));
    expect(out).toContain('lang="en"');
    expect(out).toContain('lang="fr"');
    expect(out.match(/aria-current="true"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-current="true"[^>]*>.*Français/);
  });

  it("is a plain list, not a main action, with each name also in the page's language (PIN-247)", () => {
    const out = withLocales(["en", "fr"], "en", h(LanguageMenu, { onClose: () => {} }));
    expect(out).toContain('class="pn-lang-list"');
    expect(out).not.toContain("pn-btn-primary");
    expect(out.match(/class="pn-lang-option"/g)).toHaveLength(2);
    // "French" under "Français" on an English page; nothing repeated under "English".
    expect(out).toMatch(/lang="fr">Français<\/span><span class="pn-lang-gloss">French</);
    expect(out).not.toMatch(/lang="en">English<\/span><span class="pn-lang-gloss">/);
  });

  it("never repeats a language's own name as its gloss, whatever the case", () => {
    const out = withLocales(["en", "fr"], "fr", h(LanguageMenu, { onClose: () => {} }));
    expect(out).not.toMatch(/lang="fr">Français<\/span><span class="pn-lang-gloss">/);
    expect(out).toMatch(/lang="en">English<\/span><span class="pn-lang-gloss">anglais</);
  });

  it("shows the current language on the menu's Language entry (PIN-247)", () => {
    const board = {
      me: null,
      isHost: false,
      canChangeLook: false,
      plus: null,
      onJoin() {},
      onEditName() {},
      onChangeLook() {},
      onBoardPlus() {},
      onDeleteBoard() {},
    };
    const out = withLocales(["en", "fr"], "fr", h(YouView, { auth: linkOnly, board, initialOpen: true }));
    expect(out).toMatch(/Langue.*Français/);
  });

  it("puts a language switch in the footer only with more than one language (PIN-247)", () => {
    expect(withLocales(["en"], "en", h(LanguageLink))).toBe("");
    const out = withLocales(["en", "fr"], "fr", h(LanguageLink));
    expect(out).toContain('class="pn-foot-lang"');
    expect(out).toContain('aria-haspopup="dialog"');
    expect(out).toContain('<span lang="fr">Français</span>');
  });

  it("adds Language to the menu only with more than one language", () => {
    const board = {
      me: null,
      isHost: false,
      canChangeLook: false,
      plus: null,
      onJoin() {},
      onEditName() {},
      onChangeLook() {},
      onBoardPlus() {},
      onDeleteBoard() {},
    };
    const open = (enabled: ("en" | "fr")[]) =>
      withLocales(enabled, "en", h(YouView, { auth: linkOnly, board, initialOpen: true }));
    expect(open(["en"])).not.toContain("Language");
    expect(open(["en", "fr"])).toContain("Language");
  });
});
