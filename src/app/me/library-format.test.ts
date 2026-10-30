import { describe, expect, it } from "vitest";
import { boardCardMeta, formatShortDate, pinButtonView } from "./library-format";

describe("My boards / My pins formatting (PIN-104)", () => {
  it("formats the last-active day in UTC", () => {
    expect(formatShortDate(Date.UTC(2026, 9, 29, 23, 59))).toBe("Oct 29");
    expect(formatShortDate(Date.UTC(2026, 10, 3, 0, 0))).toBe("Nov 3");
  });

  it("writes a board card's two mono lines with singular and plural counts", () => {
    const at = Date.UTC(2026, 9, 29, 12);
    expect(boardCardMeta(1, at)).toEqual({ mine: "1 thing of yours", last: "Oct 29" });
    expect(boardCardMeta(4, at)).toEqual({ mine: "4 things of yours", last: "Oct 29" });
    expect(boardCardMeta(0, at).mine).toBe("0 things of yours");
  });

  it("maps every pin button state to words, an icon and whether it can be pressed", () => {
    expect(pinButtonView("idle")).toEqual({ label: "Pin here", icon: "pin", inert: false, done: false });
    expect(pinButtonView("pinning")).toMatchObject({ label: "Pinning…", inert: true, done: false });
    expect(pinButtonView("pinned")).toMatchObject({ label: "Pinned", icon: "check", inert: true, done: true });
    expect(pinButtonView("already")).toMatchObject({ label: "Already pinned", icon: "check", inert: true, done: true });
    expect(pinButtonView("failed")).toMatchObject({ label: "Try again", inert: false, done: false });
  });

  it("keeps emoji out of every state label", () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const state of ["idle", "pinning", "pinned", "already", "failed"] as const) {
      expect(pinButtonView(state).label).not.toMatch(emoji);
    }
  });
});
