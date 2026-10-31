import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocaleProvider } from "../../i18n/client";
import { StartLookSheet } from "./StartLookSheet";

const noop = () => {};
const props = {
  suggestion: { skin: "cork", reason: "home" } as const,
  skin: "cork",
  busy: false,
  error: "",
  onPick: noop,
  onCreate: noop,
  onClose: noop,
} as const;

const inFrench = () =>
  renderToStaticMarkup(
    h(LocaleProvider, { locale: "fr", enabled: ["en", "fr"], cookieMaxAgeSeconds: 1, children: h(StartLookSheet, props) }),
  );

// PIN-232: the create flow is the first screen a visitor sees; it read
// "Choisir Cork" in French because skinName() was called without the locale.
describe("the create flow's look step (PIN-232)", () => {
  it("names the look in the visitor's language: button, suggestion line and picker", () => {
    const out = inFrench();
    expect(out).toContain("Choisir Liège");
    expect(out).toContain("<b>Liège</b>");
    expect(out).toContain("Ambiance maison.");
    // The English name appears nowhere the visitor can read it.
    expect(out).not.toContain("Cork");
    expect(out).not.toContain("Use ");
  });

  it("still reads English without a provider", () => {
    const out = renderToStaticMarkup(h(StartLookSheet, props));
    expect(out).toContain("Use Cork");
    expect(out).toContain("<b>Cork</b>");
  });

  it("keeps the retry and creating lines for the busy and error states", () => {
    const render = (over: Record<string, unknown>) =>
      renderToStaticMarkup(
        h(LocaleProvider, {
          locale: "fr",
          enabled: ["en", "fr"],
          cookieMaxAgeSeconds: 1,
          children: h(StartLookSheet, { ...props, ...over }),
        }),
      );
    expect(render({ busy: true })).toContain("Création…");
    const failed = render({ error: "Oups" });
    expect(failed).toContain("Réessayer");
    expect(failed).toContain("Oups");
  });
});
