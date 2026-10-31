import { describe, expect, it } from "vitest";
import { keyboardInset } from "./keyboard-inset";

// A 390x844 phone (iPhone 14 class) with a keyboard of about 336px.
const closed = { innerHeight: 844, vvHeight: 844, vvOffsetTop: 0, scale: 1 };

describe("keyboard inset (PIN-226)", () => {
  it("is 0 with the keyboard closed", () => {
    expect(keyboardInset(closed)).toBe(0);
  });

  it("is the keyboard's height when it opens over the page", () => {
    expect(keyboardInset({ ...closed, vvHeight: 508 })).toBe(336);
  });

  it("takes off what the browser already scrolled the visible part down", () => {
    // iOS scrolls the visual viewport to keep the caret in view: the
    // visible part ends 336 - 120 = 216px above the layout bottom.
    expect(keyboardInset({ ...closed, vvHeight: 508, vvOffsetTop: 120 })).toBe(216);
    // Scrolled all the way down: the visible part reaches the bottom.
    expect(keyboardInset({ ...closed, vvHeight: 508, vvOffsetTop: 336 })).toBe(0);
  });

  it("rounds to whole pixels (fractional device pixels)", () => {
    expect(keyboardInset({ ...closed, vvHeight: 507.6 })).toBe(336);
    expect(keyboardInset({ ...closed, vvHeight: 508, vvOffsetTop: 0.4 })).toBe(336);
  });

  it("is 0 while pinch-zoomed, keyboard or not", () => {
    expect(keyboardInset({ ...closed, vvHeight: 422, scale: 2 })).toBe(0);
    expect(keyboardInset({ ...closed, vvHeight: 254, vvOffsetTop: 40, scale: 1.5 })).toBe(0);
  });

  it("never goes negative when the visible part is taller than the layout", () => {
    expect(keyboardInset({ ...closed, vvHeight: 900 })).toBe(0);
    expect(keyboardInset({ ...closed, vvOffsetTop: 12 })).toBe(0);
  });

  it("is 0 for readings that make no sense", () => {
    expect(keyboardInset({ ...closed, innerHeight: Number.NaN })).toBe(0);
    expect(keyboardInset({ ...closed, vvHeight: Number.POSITIVE_INFINITY })).toBe(0);
    expect(keyboardInset({ ...closed, vvOffsetTop: Number.NaN, vvHeight: 508 })).toBe(0);
    expect(keyboardInset({ ...closed, scale: Number.NaN, vvHeight: 508 })).toBe(0);
    expect(keyboardInset({ ...closed, scale: 0, vvHeight: 508 })).toBe(0);
    expect(keyboardInset({ ...closed, innerHeight: 0, vvHeight: 0 })).toBe(0);
    expect(keyboardInset({ ...closed, vvHeight: -10 })).toBe(0);
  });
});
