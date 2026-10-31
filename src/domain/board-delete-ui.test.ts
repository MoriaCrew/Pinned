import { describe, expect, it } from "vitest";
import {
  afterBoardDeleteHref,
  boardDeleteOutcome,
  boardPollEnabled,
  boardPollError,
  isBoardDeletedFlag,
  isBoardGone,
  runBoardDelete,
  showBoardGone,
  urlWithoutBoardDeletedFlag,
  type BoardDeletePhase,
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

describe("the board poll's errors (PIN-168)", () => {
  it("a 404 means the board is gone, any other failure is just a load error", () => {
    expect(isBoardGone(boardPollError(404))).toBe(true);
    expect(isBoardGone(boardPollError(500))).toBe(false);
    expect(isBoardGone(new Error("load failed"))).toBe(false);
    expect(isBoardGone(null)).toBe(false);
  });
});

describe("the host's own delete and the poll (PIN-168)", () => {
  it("polls only while no delete of ours is in flight or done", () => {
    expect(boardPollEnabled("idle")).toBe(true);
    expect(boardPollEnabled("pending")).toBe(false);
    expect(boardPollEnabled("left")).toBe(false);
  });

  it("a poll 404 shows not-found only when it can't be our own delete landing", () => {
    expect(showBoardGone("idle", boardPollError(404))).toBe(true);
    expect(showBoardGone("pending", boardPollError(404))).toBe(false);
    expect(showBoardGone("left", boardPollError(404))).toBe(false);
    expect(showBoardGone("idle", boardPollError(500))).toBe(false);
    expect(showBoardGone("idle", null)).toBe(false);
  });

  const run = async (answer: () => Promise<{ ok: boolean; status: number }>) => {
    const phases: BoardDeletePhase[] = [];
    const calls: { url: string; init: RequestInit; phaseAtSend: BoardDeletePhase | undefined }[] = [];
    const outcome = await runBoardDelete(
      "AbCdEfGhIjKlMnOpQrStUv",
      (url, init) => {
        calls.push({ url, init, phaseAtSend: phases.at(-1) });
        return answer();
      },
      (phase) => phases.push(phase),
    );
    return { outcome, phases, calls };
  };

  it("pauses the poll before the DELETE goes out, then leaves on a 204", async () => {
    const { outcome, phases, calls } = await run(async () => ({ ok: true, status: 204 }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.phaseAtSend).toBe("pending");
    expect(calls[0]?.url).toBe("/api/boards/AbCdEfGhIjKlMnOpQrStUv");
    expect(calls[0]?.init).toMatchObject({ method: "DELETE", credentials: "same-origin" });
    expect(phases).toEqual(["pending", "left"]);
    expect(outcome).toBe("deleted");
  });

  it("resumes the poll when the delete did not happen", async () => {
    expect(await run(async () => ({ ok: false, status: 404 }))).toMatchObject({ outcome: "gone", phases: ["pending", "idle"] });
    expect(await run(async () => ({ ok: false, status: 500 }))).toMatchObject({ outcome: "failed", phases: ["pending", "idle"] });
    expect(
      await run(async () => {
        throw new TypeError("network down");
      }),
    ).toMatchObject({ outcome: "failed", phases: ["pending", "idle"] });
  });
});
