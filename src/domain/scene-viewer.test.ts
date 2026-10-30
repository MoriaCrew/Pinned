import { describe, expect, it } from "vitest";
import type { BoardViewScene } from "./board-view";
import { stripItems } from "./board-ui";
import { parseSceneParam, sceneIdInUrl, stepScene, urlWithScene, viewerSceneIds } from "./scene-viewer";

const board = "https://pinneds.test/g/AAAAAAAAAAAAAAAAAAAAAA";

function scene(id: string, status: BoardViewScene["status"], createdAt: number): BoardViewScene {
  return { id, createdBy: "p1", elementIds: ["e1"], prompt: id, status, imageUrl: status === "ready" ? `/img/${id}` : null, createdAt };
}

describe("scene viewer URL state (PIN-131)", () => {
  it("parses ?scene=, taking the first of several and ignoring blanks", () => {
    expect(parseSceneParam("s1")).toBe("s1");
    expect(parseSceneParam(["s2", "s3"])).toBe("s2");
    expect(parseSceneParam(" ")).toBeNull();
    expect(parseSceneParam(undefined)).toBeNull();
    expect(sceneIdInUrl(`${board}?tryon=zine&scene=s1#top`)).toBe("s1");
    expect(sceneIdInUrl(board)).toBeNull();
  });

  it("serializes with and without ?scene=, keeping other params and the hash", () => {
    expect(urlWithScene(`${board}?tryon=zine#top`, "s 1")).toBe(`${board}?tryon=zine&scene=s+1#top`);
    expect(urlWithScene(`${board}?scene=s1`, "s2")).toBe(`${board}?scene=s2`);
    expect(urlWithScene(`${board}?tryon=zine&scene=s1`, null)).toBe(`${board}?tryon=zine`);
    expect(sceneIdInUrl(urlWithScene(board, "s 1"))).toBe("s 1");
  });

  it("views ready prints only, newest first, like the strip", () => {
    const items = stripItems([scene("new", "running", 3), scene("mid", "ready", 2), scene("bad", "failed", 2), scene("old", "ready", 1)], "bad");
    expect(viewerSceneIds(items)).toEqual(["mid", "old"]);
  });

  it("steps to the next and previous print and stops at the ends", () => {
    const ids = ["s3", "s2", "s1"];
    expect(stepScene(ids, "s3", 1)).toBe("s2");
    expect(stepScene(ids, "s2", -1)).toBe("s3");
    expect(stepScene(ids, "s3", -1)).toBeNull();
    expect(stepScene(ids, "s1", 1)).toBeNull();
    // An unknown, hidden or deleted id is not viewable, so it has no neighbours.
    expect(stepScene(ids, "gone", 1)).toBeNull();
  });
});
