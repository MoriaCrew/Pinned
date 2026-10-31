import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocaleProvider } from "../../i18n/client";
import { LanguageMenu } from "./LanguageMenu";
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

  it("adds Language to the menu only with more than one language", () => {
    const board = { me: null, isHost: false, onJoin() {}, onEditName() {}, onChangeLook() {}, onDeleteBoard() {} };
    const open = (enabled: ("en" | "fr")[]) =>
      withLocales(enabled, "en", h(YouView, { auth: linkOnly, board, initialOpen: true }));
    expect(open(["en"])).not.toContain("Language");
    expect(open(["en", "fr"])).toContain("Language");
  });
});
