import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../../policy/policy";
import { DeleteBoardSheetView } from "./DeleteBoardSheet";

const noop = () => {};
const sheet = (over: Partial<Parameters<typeof DeleteBoardSheetView>[0]> = {}) =>
  renderToStaticMarkup(h(DeleteBoardSheetView, { title: "Lisbon trip", onDelete: noop, onKeep: noop, ...over }));

describe("delete board sheet (PIN-168)", () => {
  it("names the board and says it is gone for everyone, pictures included, and can't be undone", () => {
    const out = sheet();
    expect(out).toContain('role="dialog"');
    expect(out).toContain("Delete this board?");
    expect(out).toContain("“Lisbon trip”");
    expect(out).toContain("gone for everyone, pictures included");
    expect(out).toContain("This can&#x27;t be undone.");
  });

  it("offers Delete board in the destructive style and Keep board, focused first, as a plain secondary button", () => {
    const out = sheet();
    expect(out).toMatch(/<button[^>]*class="[^"]*pn-btn[^"]*deleteYes[^"]*"[^>]*>Delete board<\/button>/);
    const keep = out.match(/<button[^>]*id="([^"]+)"[^>]*>Keep board<\/button>/);
    expect(keep).not.toBeNull();
    expect(keep?.[0]).toContain("pn-btn-secondary");
    expect(out).not.toContain("pn-btn-primary");
    // The sheet puts the caret on Keep when it opens (initialFocusId), never on Delete.
    expect(out).not.toMatch(/<button[^>]*id="[^"]+"[^>]*>Delete board<\/button>/);
  });

  it("keeps a long board name whole", () => {
    const title = "A".repeat(DEFAULT_POLICY.boardTitleMaxChars);
    expect(sheet({ title })).toContain(`“${title}”`);
  });

  it("disables both answers and says Deleting while the delete is in flight", () => {
    const out = sheet({ busy: true });
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Deleting…<\/button>/);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Keep board<\/button>/);
    expect(sheet()).not.toContain('disabled=""');
  });

  it("keeps the alert line mounted, empty until a delete fails, with a line for each failure", () => {
    expect(sheet()).toMatch(/<p[^>]*role="alert"[^>]*><\/p>/);
    expect(sheet({ error: "failed" })).toMatch(/role="alert"[^>]*>Couldn&#x27;t delete the board\. Try again\.<\/p>/);
    expect(sheet({ error: "gone" })).toMatch(/role="alert"[^>]*>That didn&#x27;t work\. The board may already be gone, or you&#x27;re no longer its host\.<\/p>/);
  });
});
