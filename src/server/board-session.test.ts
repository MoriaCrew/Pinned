import { describe, expect, it } from "vitest";
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

  it("normalizes display names: trim, single spaces, 30 chars, no controls", () => {
    expect(normalizeDisplayName("  Ana   Maria ")).toBe("Ana Maria");
    expect(() => normalizeDisplayName(42)).toThrowError(
      new BoardApiError("Choose a display name."),
    );
    expect(() => normalizeDisplayName("   ")).toThrow(BoardApiError);
    expect(() => normalizeDisplayName("x".repeat(31))).toThrow(BoardApiError);
    expect(() => normalizeDisplayName("badname")).toThrow(BoardApiError);
  });

  it("parseJoinBoardInput surfaces name errors as BoardApiError 400", () => {
    expect(parseJoinBoardInput({ displayName: "Ana", reclaimPin: "1234" })).toEqual({
      displayName: "Ana",
      reclaimPin: "1234",
    });
    let caught: unknown;
    try {
      parseJoinBoardInput({ displayName: "" });
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
