import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../policy/policy";
import { normalizeElementLabel } from "./element-label";

const CAP = DEFAULT_POLICY.elementLabelMaxChars;

describe("normalizeElementLabel (PIN-156)", () => {
  it("trims and collapses whitespace to single spaces", () => {
    expect(normalizeElementLabel("  Brass \t desk\n\nlamp  ", CAP)).toEqual({ ok: true, label: "Brass desk lamp" });
  });

  it("refuses empty, whitespace-only and non-string input", () => {
    expect(normalizeElementLabel("", CAP)).toEqual({ ok: false, reason: "empty" });
    expect(normalizeElementLabel(" \n\t ", CAP)).toEqual({ ok: false, reason: "empty" });
    for (const raw of [undefined, null, 42, ["lamp"], { label: "lamp" }]) {
      expect(normalizeElementLabel(raw, CAP)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("refuses control characters that whitespace collapsing leaves behind", () => {
    expect(normalizeElementLabel("lamp\u0000", CAP)).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeElementLabel("la\u001bmp", CAP)).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeElementLabel("lamp\u007f", CAP)).toEqual({ ok: false, reason: "invalid" });
  });

  it("allows exactly the cap and refuses one over, counting code points", () => {
    const astral = "\u{1D49C}"; // one code point, two UTF-16 units
    expect(normalizeElementLabel("a".repeat(CAP), CAP)).toEqual({ ok: true, label: "a".repeat(CAP) });
    expect(normalizeElementLabel("a".repeat(CAP + 1), CAP)).toEqual({ ok: false, reason: "tooLong" });
    expect(normalizeElementLabel(astral.repeat(5), 5)).toEqual({ ok: true, label: astral.repeat(5) });
    expect(normalizeElementLabel(astral.repeat(6), 5)).toEqual({ ok: false, reason: "tooLong" });
  });
});
