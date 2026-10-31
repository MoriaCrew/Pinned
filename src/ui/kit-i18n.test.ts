import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fr from "../i18n/messages/fr.json";
import { LocaleProvider } from "../i18n/client";
import { t, tf } from "../i18n";
import { AvatarStack, CreditLine, Developing, Pin, PlusSheet, SceneCard, TryOnBar, boardMetaLine, compactCreditsName, pickedCountLabel } from "./index";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const inFrench = (child: Parameters<typeof h>[2]) =>
  html(h(LocaleProvider, { locale: "fr", enabled: ["en", "fr"], cookieMaxAgeSeconds: 1, children: child }));

describe("UI kit sentences (PIN-194), English unchanged", () => {
  it("names a remix with and without an owner, title in bold", () => {
    const withOwner = html(h(CreditLine, { items: [], remixOf: { sceneId: "s", title: "Desk day", owner: "Robin" } as never }));
    expect(withOwner).toContain("Remix of <b>Desk day</b> by Robin");
    const noOwner = html(h(CreditLine, { items: [], remixOf: { sceneId: "s", title: "Desk day" } as never }));
    expect(noOwner).toContain("Remix of <b>Desk day</b></p>");
  });

  it("joins credit names with the language's own list", () => {
    expect(compactCreditsName("Made from", ["teal mug", "rubber duck", "succulent"])).toBe("Made from teal mug, rubber duck and succulent");
    expect(compactCreditsName("Fait de", ["a", "b", "c"], "fr")).toBe("Fait de a, b et c");
  });

  it("labels scenes and the developing print as one sentence", () => {
    expect(html(h(SceneCard, { src: "/s.webp", idea: "Desk day" }))).toContain('aria-label="Scene: Desk day"');
    expect(html(h(SceneCard, { src: "/s.webp" }))).toContain('aria-label="Scene"');
    expect(html(h(Developing, { stickers: [], idea: "Desk day" }))).toContain('aria-label="Making a scene: Desk day"');
  });

  it("speaks pins, people and the Plus button as whole phrases", () => {
    expect(html(h(Pin, { src: "/a.webp", label: "Duck", state: "dropped", onToggle: () => {} }))).toContain('aria-label="Duck, left out"');
    const people = [{ id: "a", name: "Ana" }, { id: "b", name: "Bo" }];
    expect(html(h(AvatarStack, { people }))).toContain('aria-label="2 people: Ana, Bo"');
    const sheet = html(h(PlusSheet, { plan: "board", onPlanChange: () => {}, prices: { board: "€3", host: "€5" }, available: true }));
    expect(sheet).toContain("Get Plus · €3");
    expect(html(h(TryOnBar, { skin: "paper" }))).toContain("Trying on <b>");
    expect(boardMetaLine({ people: 2, things: 1 })).toBe("2 people · 1 thing");
    expect(pickedCountLabel(1, 4)).toBe("1 of 4 picked");
  });
});

describe("UI kit follows the language (PIN-194)", () => {
  // fr.json has no ui.* keys until PIN-189 fills it, so borrow a few here.
  const borrowed: Record<string, string> = {
    "ui.sceneLabel": "Scène : {idea}",
    "ui.remixOfBy": "Remix de {title} par {owner}",
    "ui.pinWithState": "{state} : {label}",
    "ui.plusGetPrice": "Obtenir Plus · {price}",
  };
  beforeAll(() => Object.assign(fr, borrowed));
  afterAll(() => {
    for (const key of Object.keys(borrowed)) delete (fr as Record<string, string>)[key];
  });

  it("renders each sentence in the provider's language and word order", () => {
    expect(inFrench(h(SceneCard, { src: "/s.webp", idea: "Bureau" }))).toContain('aria-label="Scène : Bureau"');
    expect(inFrench(h(CreditLine, { items: [], remixOf: { sceneId: "s", title: "Bureau", owner: "Robin" } as never }))).toContain(
      "Remix de <b>Bureau</b> par Robin",
    );
    expect(inFrench(h(Pin, { src: "/a.webp", label: "Canard", state: "dropped", onToggle: () => {} }))).toContain("left out : Canard");
    expect(inFrench(h(PlusSheet, { plan: "board", onPlanChange: () => {}, prices: { board: "3 €", host: "5 €" }, available: true }))).toContain(
      "Obtenir Plus · 3 €",
    );
  });

  it("keeps placeholders so word order can differ by language", () => {
    expect(tf("en", "ui.remixOfBy", { title: "T", owner: "O" })).toBe("Remix of T by O");
    for (const key of ["ui.remixOfBy", "ui.remixOfTitle", "ui.creditsNamed", "ui.sceneLabel", "ui.makingSceneLabel", "ui.pinWithState", "ui.peopleNamed", "ui.plusGetPrice"] as const) {
      expect(t("en", key)).toMatch(/\{\w+\}/);
    }
  });
});
