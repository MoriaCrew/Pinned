import { describe, expect, it } from "vitest";
import { landingSecondary } from "./landing-actions";

describe("landing second action (PIN-264)", () => {
  it("offers the demo to anyone without boards, when the demo is on", () => {
    expect(landingSecondary({ demoEnabled: true, myBoardSlugs: null })).toEqual({ kind: "demo" });
    expect(landingSecondary({ demoEnabled: true, myBoardSlugs: [] })).toEqual({ kind: "demo" });
    expect(landingSecondary({ demoEnabled: false, myBoardSlugs: null })).toEqual({ kind: "none" });
    expect(landingSecondary({ demoEnabled: false, myBoardSlugs: [] })).toEqual({ kind: "none" });
  });

  it("opens the one board, or lists several, instead of the demo", () => {
    expect(landingSecondary({ demoEnabled: true, myBoardSlugs: ["s1"] })).toEqual({ kind: "myBoard", slug: "s1" });
    expect(landingSecondary({ demoEnabled: false, myBoardSlugs: ["s1"] })).toEqual({ kind: "myBoard", slug: "s1" });
    expect(landingSecondary({ demoEnabled: true, myBoardSlugs: ["s1", "s2"] })).toEqual({ kind: "myBoards" });
    // A blank slug never becomes a link.
    expect(landingSecondary({ demoEnabled: true, myBoardSlugs: [""] })).toEqual({ kind: "demo" });
  });
});
