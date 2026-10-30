import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardDeletedNotice } from "./BoardDeletedNotice";

describe("Board deleted notice (PIN-168)", () => {
  it("is one status line with a check icon when the page was reached with ?deleted=1", () => {
    const out = renderToStaticMarkup(h(BoardDeletedNotice, { show: true }));
    expect(out).toMatch(/^<p class="pn-lib-notice" role="status"><svg[^>]*aria-hidden="true"/);
    expect(out).toMatch(/<\/svg>Board deleted<\/p>$/);
  });

  it("renders nothing otherwise", () => {
    expect(renderToStaticMarkup(h(BoardDeletedNotice, { show: false }))).toBe("");
  });
});
