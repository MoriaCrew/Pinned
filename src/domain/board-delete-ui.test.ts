import { describe, expect, it } from "vitest";
import {
  afterBoardDeleteHref,
  boardDeleteOutcome,
  isBoardDeletedFlag,
  urlWithoutBoardDeletedFlag,
} from "./board-delete-ui";

describe("where the host lands after a delete (PIN-168)", () => {
  it("goes to My boards when signed in, else the home page, with the flag and no slug", () => {
    expect(afterBoardDeleteHref(true)).toBe("/me/boards?deleted=1");
    expect(afterBoardDeleteHref(false)).toBe("/?deleted=1");
  });

  it("reads the flag as a page receives it", () => {
    expect(isBoardDeletedFlag("1")).toBe(true);
    expect(isBoardDeletedFlag(["1", "0"])).toBe(true);
    expect(isBoardDeletedFlag(undefined)).toBe(false);
    expect(isBoardDeletedFlag("true")).toBe(false);
    expect(isBoardDeletedFlag([])).toBe(false);
  });

  it("strips only the flag from the URL", () => {
    expect(urlWithoutBoardDeletedFlag("https://pinneds.app/?deleted=1")).toBe("/");
    expect(urlWithoutBoardDeletedFlag("https://pinneds.app/me/boards?x=1&deleted=1#top")).toBe("/me/boards?x=1#top");
    expect(urlWithoutBoardDeletedFlag("https://pinneds.app/me/boards")).toBeNull();
    expect(urlWithoutBoardDeletedFlag("not a url")).toBeNull();
  });
});

describe("the DELETE answer (PIN-168)", () => {
  it("204 is deleted, the uniform 404 is gone, everything else can be tried again", () => {
    expect(boardDeleteOutcome({ ok: true, status: 204 })).toBe("deleted");
    expect(boardDeleteOutcome({ ok: false, status: 404 })).toBe("gone");
    expect(boardDeleteOutcome({ ok: false, status: 500 })).toBe("failed");
    expect(boardDeleteOutcome({ ok: false, status: 429 })).toBe("failed");
    expect(boardDeleteOutcome({ ok: false, status: 403 })).toBe("failed");
    expect(boardDeleteOutcome(null)).toBe("failed");
  });
});
