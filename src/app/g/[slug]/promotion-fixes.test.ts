import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MakeSheet } from "./MakeSheet";

// Bugbot findings on the dev -> main promotion PR (PIN-232). The skin-name
// and recorder findings have their own tests; these are the small ones.
const read = (...parts: string[]) => readFileSync(path.join(process.cwd(), ...parts), "utf8");
const noop = () => {};

function sheet(over: Partial<Parameters<typeof MakeSheet>[0]>) {
  return renderToStaticMarkup(
    h(MakeSheet, {
      cards: [],
      chips: [],
      fixedChips: [],
      pinsPerScene: { min: 1, max: 4 },
      promptMaxChars: 500,
      initialPrompt: "",
      dictate: null,
      onMake: noop,
      onRemovePick: noop,
      onAddPicks: noop,
      onClose: noop,
      ...over,
    }),
  );
}

describe("F14: the ideas row shows while ideas are loading", () => {
  it("shows the loading chip even when the Policy list has no fixed ideas", () => {
    const out = sheet({ chipsLoading: true });
    expect(out).toContain("pn-make-ideas");
    expect(out).toMatch(/<span class="pn-chip pn-chip-loading" aria-busy="true">Finding more ideas…<\/span>/);
  });

  it("shows no row when there is nothing to show and nothing coming", () => {
    expect(sheet({ chipsLoading: false })).not.toContain("pn-make-ideas");
  });
});

describe("F6: the rename sheet starts fresh for each opening", () => {
  it("keys the sheet on the opening, so a second rename never keeps the first draft", () => {
    // RenameSheet keeps its draft in useState(label): only a new key resets it.
    expect(read("src/app/g/[slug]/BoardClient.tsx")).toMatch(/<RenameSheet\s+key=\{renamingOpenId\}/);
  });
});

describe("F13: the library's pins keep their own sizing", () => {
  const css = read("src/ui/pinneds.css");

  it("skips off-screen layout on board pins only, not the Add sheet's or the library's", () => {
    expect(css).toContain(".pn-pins:not(.pn-add-keep, .pn-lib-pins) .pn-pin {");
    expect(css).toContain(".pn-pins:not(.pn-add-keep, .pn-lib-pins) .pn-pin > * {");
    expect(css).not.toMatch(/\.pn-pins:not\(\.pn-add-keep\)/);
  });

  it("is the grid the library renders", () => {
    expect(read("src/app/me/LibraryParts.tsx")).toContain('className="pn-pins pn-lib-pins"');
  });
});
