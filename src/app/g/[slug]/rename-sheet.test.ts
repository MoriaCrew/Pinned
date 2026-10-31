import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../../policy/policy";
import { TextField } from "../../../ui";
import { RenameSheet } from "./RenameSheet";

const CAP = DEFAULT_POLICY.elementLabelMaxChars;
const noop = () => {};
const sheet = (over: Partial<Parameters<typeof RenameSheet>[0]> = {}) =>
  renderToStaticMarkup(h(RenameSheet, { label: "Teal mug", maxChars: CAP, onSave: noop, onClose: noop, ...over }));
const saveDisabled = (out: string) => /<button[^>]*disabled=""[^>]*>Save<\/button>/.test(out);

describe("rename sheet (PIN-157)", () => {
  it("shows the name field with the current label, the code point count, Save and Cancel", () => {
    const out = sheet();
    expect(out).toContain("Rename this pin");
    expect(out).toContain('value="Teal mug"');
    expect(out).toContain(`8/${CAP}`);
    expect(out).toContain(">Save<");
    expect(out).toContain(">Cancel<");
    expect(saveDisabled(out)).toBe(false);
  });

  it("keeps the alert line mounted, empty until there is something to say", () => {
    expect(sheet()).toMatch(/<p[^>]*role="alert"[^>]*><\/p>/);
    expect(sheet({ error: "Try again." })).toMatch(/role="alert"[^>]*>Try again\.<\/p>/);
  });

  it("sets no native maxlength: it counts UTF-16 units, so an emoji label would stop early", () => {
    const label = "\u{1F469}\u200D\u{1F373} pan"; // 7 code points, 9 UTF-16 units
    expect([...label]).toHaveLength(7);
    expect(label).toHaveLength(9);
    const out = sheet({ label, maxChars: 7 });
    expect(out).not.toMatch(/maxlength/i);
    expect(out).toContain("7/7");
    expect(saveDisabled(out)).toBe(false);
    expect(saveDisabled(sheet({ label, maxChars: 6 }))).toBe(true);
  });

  it("disables Save and says why for a name over the cap or with refused characters, and only disables it for an empty one", () => {
    const over = sheet({ label: "x".repeat(CAP + 1) });
    expect(saveDisabled(over)).toBe(true);
    expect(over).toContain(`Give it a name up to ${CAP} characters.`);
    const control = sheet({ label: "lamp\u202E" });
    expect(saveDisabled(control)).toBe(true);
    expect(control).toContain("Give it a name up to");
    const empty = sheet({ label: "  " });
    expect(saveDisabled(empty)).toBe(true);
    expect(empty).not.toContain("Give it a name up to");
  });

  it("disables Save while a save is in flight", () => {
    expect(saveDisabled(sheet({ busy: true }))).toBe(true);
  });
});

describe("TextField limits (PIN-157)", () => {
  it("maxLength sets the native attribute and the count; softMaxLength only the count", () => {
    const hard = renderToStaticMarkup(h(TextField, { label: "A", value: "ab", maxLength: 5 }));
    expect(hard).toContain('maxLength="5"');
    expect(hard).toContain("2/5");
    const soft = renderToStaticMarkup(h(TextField, { label: "A", value: "ab", softMaxLength: 5 }));
    expect(soft).not.toMatch(/maxlength/i);
    expect(soft).toContain("2/5");
  });
});
