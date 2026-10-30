import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../policy/policy";
import { normalizeElementLabel, withElementLabel } from "./element-label";

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

  it("refuses C1 controls, bidi controls, tag characters and lone surrogates as invalid", () => {
    const refused = {
      c1: ["lamp\u0085", "\u009b31m lamp"],
      bidi: ["\u202elamp", "lamp\u202a", "\u2066lamp\u2069", "\u200elamp", "lamp\u200f", "\u061clamp"],
      tags: ["lamp\u{E0041}\u{E007F}"],
      loneSurrogates: ["\ud800 lamp", "lamp \udc00"],
    };
    for (const raw of Object.values(refused).flat()) {
      expect(normalizeElementLabel(raw, CAP)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("calls a label with no visible character empty, and keeps ZWJ emoji and ZWNJ text", () => {
    for (const raw of ["\u200b", "\u2060\u200b", "\u200d", "\u0301"]) {
      expect(normalizeElementLabel(raw, CAP)).toEqual({ ok: false, reason: "empty" });
    }
    const cookPan = "\u{1F469}\u200d\u{1F373} pan"; // woman cook (ZWJ sequence) + "pan"
    const zwnj = "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645"; // Persian word with a ZWNJ
    expect(normalizeElementLabel(cookPan, CAP)).toEqual({ ok: true, label: cookPan });
    expect(normalizeElementLabel(zwnj, CAP)).toEqual({ ok: true, label: zwnj });
  });

  it("allows exactly the cap and refuses one over, counting code points", () => {
    const astral = "\u{1D49C}"; // one code point, two UTF-16 units
    expect(normalizeElementLabel("a".repeat(CAP), CAP)).toEqual({ ok: true, label: "a".repeat(CAP) });
    expect(normalizeElementLabel("a".repeat(CAP + 1), CAP)).toEqual({ ok: false, reason: "tooLong" });
    expect(normalizeElementLabel(astral.repeat(5), 5)).toEqual({ ok: true, label: astral.repeat(5) });
    expect(normalizeElementLabel(astral.repeat(6), 5)).toEqual({ ok: false, reason: "tooLong" });
  });
});

describe("withElementLabel (PIN-157)", () => {
  const view = {
    board: "b1",
    elements: [
      { id: "e1", label: "Teal mug" },
      { id: "e2", label: "Rubber duck" },
    ],
  };

  it("replaces only that thing's label and leaves the input alone", () => {
    const next = withElementLabel(view, "e2", "Bath duck");
    expect(next.elements).toEqual([
      { id: "e1", label: "Teal mug" },
      { id: "e2", label: "Bath duck" },
    ]);
    expect(next.elements[0]).toBe(view.elements[0]);
    expect(next.board).toBe("b1");
    expect(view.elements[1].label).toBe("Rubber duck");
  });

  it("returns the same view when the thing is gone", () => {
    expect(withElementLabel(view, "e9", "Anything")).toBe(view);
  });
});
