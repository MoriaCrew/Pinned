import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../policy/policy";
import {
  BoardApiError,
  normalizeDisplayName,
  parseJoinBoardInput,
  playerCookieName,
  readCookieValue,
} from "./board-session";

/**
 * PIN-93: these helpers moved here from the deleted game-era
 * player-session module. Behavior (cookie name, name rules, error
 * copy/status) is byte-identical to before the move.
 */
describe("board-session helpers (moved in PIN-93)", () => {
  it("keeps the same per-board cookie name", () => {
    expect(playerCookieName("board-slug")).toBe("pinned_player_board-slug");
  });

  it("reads one cookie value out of a header and decodes it", () => {
    const header = "a=1; pinned_player_x=hello%20world; b=2";
    expect(readCookieValue(header, "pinned_player_x")).toBe("hello world");
    expect(readCookieValue(header, "missing")).toBeNull();
    expect(readCookieValue(null, "pinned_player_x")).toBeNull();
  });

  it("normalizes display names: trim, single spaces, Policy max chars, no controls", () => {
    const max = DEFAULT_POLICY.displayNameMaxChars;
    expect(max).toBe(30);
    expect(normalizeDisplayName("  Ana   Maria ", max)).toBe("Ana Maria");
    expect(() => normalizeDisplayName(42, max)).toThrowError("Choose a display name.");
    expect(() => normalizeDisplayName("   ", max)).toThrow(BoardApiError);
    expect(normalizeDisplayName("x".repeat(max), max)).toBe("x".repeat(max));
    expect(() => normalizeDisplayName("x".repeat(max + 1), max)).toThrow(BoardApiError);
    expect(() => normalizeDisplayName("bad\u0001name", max)).toThrow(BoardApiError);
  });

  it("names the Policy cap in the error (PIN-196: no hard-coded 30)", () => {
    let caught: unknown;
    try {
      normalizeDisplayName("x".repeat(13), 12);
    } catch (error) {
      caught = error;
    }
    expect((caught as BoardApiError).message).toBe("Choose a display name up to 12 characters.");
    expect((caught as BoardApiError).userMessage).toEqual({
      key: "error.displayNameInvalid",
      values: { max: 12 },
    });
  });

  it("parseJoinBoardInput surfaces name errors as BoardApiError 400", () => {
    expect(parseJoinBoardInput({ displayName: "Ana", reclaimPin: "1234" }, DEFAULT_POLICY)).toEqual({
      displayName: "Ana",
      reclaimPin: "1234",
    });
    let caught: unknown;
    try {
      parseJoinBoardInput({ displayName: "" }, DEFAULT_POLICY);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoardApiError);
    expect((caught as BoardApiError).status).toBe(400);
    expect((caught as BoardApiError).message).toBe(
      "Choose a display name up to 30 characters.",
    );
  });
});
