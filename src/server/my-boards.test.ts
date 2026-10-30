import { describe, expect, it } from "vitest";
import type { Board, Element, Participant, Pin, Scene } from "../domain/board";
import { emptyBoardCounters } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import type { UserProfile } from "../domain/user";
import { InMemoryUserRepository } from "../domain/user-repository";
import { resolvePolicy } from "../policy/policy";
import { listMyBoards } from "./my-boards";
import { findClaimedParticipant } from "./user-session";

const USER: UserProfile = { uid: "synthetic-alice", createdAt: 1, updatedAt: 1 };

function board(slug: string, createdAt: number): Board {
  return {
    slug,
    title: `Board ${slug}`,
    counters: emptyBoardCounters(),
    createdAt,
    version: 1,
  };
}

function participant(
  id: string,
  boardId: string,
  userId?: string,
): Participant {
  return {
    id,
    boardId,
    displayName: id,
    cookieSecretHash: "hash",
    ...(userId ? { userId } : {}),
    createdAt: 1,
  };
}

function element(id: string, boardId: string, ownerId: string): Element {
  return {
    id,
    boardId,
    ownerId,
    label: id,
    description: "",
    maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
    cutoutRef: `elements/${id}.png`,
    flattenedRef: `elements/${id}-flat.png`,
    sourcePhotoId: "photo-1",
    faceFlag: false,
    createdAt: 1,
  };
}

function pin(id: string, boardId: string, elementId: string, createdAt: number): Pin {
  return { id, boardId, elementId, pinnedBy: "p1", status: "pinned", createdAt };
}

function scene(id: string, boardId: string, createdAt: number): Scene {
  return {
    id,
    boardId,
    createdBy: "p1",
    elementIds: [],
    prompt: "prompt",
    status: "ready",
    imageRef: `scenes/${id}.png`,
    promptVersion: "scene.v1",
    createdAt,
  };
}

describe("listMyBoards", () => {
  it("assembles cards sorted by last activity; skips stale index entries", async () => {
    const boards = new InMemoryBoardRepository();
    const users = new InMemoryUserRepository();
    await users.putUser(USER);

    await boards.createBoard(board("board-old", 100));
    await boards.createBoard(board("board-new", 200));
    await boards.putParticipant(participant("p-old", "board-old", USER.uid));
    await boards.putParticipant(participant("p-new", "board-new", USER.uid));
    // Stale: participant claimed by someone else now.
    await boards.createBoard(board("board-stale", 300));
    await boards.putParticipant(participant("p-stale", "board-stale", "synthetic-bob"));

    await boards.createElement(element("e1", "board-old", "p-old"));
    await boards.createElement(element("e2", "board-old", "other-person"));
    await boards.createPin(pin("pin1", "board-old", "e1", 500));
    await boards.createPin(pin("pin2", "board-old", "e2", 900));
    await boards.putScene(scene("s1", "board-old", 700));
    await boards.createElement(element("e3", "board-new", "p-new"));
    await boards.createPin(pin("pin3", "board-new", "e3", 400));

    await users.putUserBoard(USER.uid, {
      boardId: "board-old", participantId: "p-old", claimedAt: 10, updatedAt: 10,
    });
    await users.putUserBoard(USER.uid, {
      boardId: "board-new", participantId: "p-new", claimedAt: 20, updatedAt: 20,
    });
    await users.putUserBoard(USER.uid, {
      boardId: "board-stale", participantId: "p-stale", claimedAt: 30, updatedAt: 30,
    });
    await users.putUserBoard(USER.uid, {
      boardId: "board-gone", participantId: "p-gone", claimedAt: 40, updatedAt: 40,
    });

    const cards = await listMyBoards(USER, { boards, users });
    expect(cards.map((c) => c.slug)).toEqual(["board-old", "board-new"]);
    const old = cards[0];
    expect(old.myPinCount).toBe(1); // only my own element's pinned pin
    expect(old.lastActivityAt).toBe(900);
    expect(old.latestSceneImageUrl).toBe("/api/boards/board-old/scenes/s1/image?size=preview");
    expect(cards[1].latestSceneImageUrl).toBeNull();
    expect(cards[1].myPinCount).toBe(1);
  });
});

describe("findClaimedParticipant (restore lookup)", () => {
  it("index + matching userId restores; mismatched userId restores nobody", async () => {
    const boards = new InMemoryBoardRepository();
    const users = new InMemoryUserRepository();
    await boards.createBoard(board("board-a", 1));
    await boards.putParticipant(participant("p1", "board-a", USER.uid));
    await boards.putParticipant(participant("p2", "board-a", "synthetic-bob"));
    await users.putUserBoard(USER.uid, {
      boardId: "board-a", participantId: "p1", claimedAt: 1, updatedAt: 1,
    });
    // PIN-94: restore requires a fresh sign-in at the lookup clock.
    const freshDeps = {
      boards,
      users,
      policy: resolvePolicy(),
      authTimeMs: 1,
      now: () => 1,
    };
    expect(
      (await findClaimedParticipant("board-a", USER, freshDeps))?.id,
    ).toBe("p1");
    // The same live claim with a stale sign-in restores nobody.
    expect(
      await findClaimedParticipant("board-a", USER, {
        ...freshDeps,
        now: () => 1 + resolvePolicy().authFreshWindowMs + 1,
      }),
    ).toBeNull();

    // Forged/stale index pointing at another user's participant.
    await users.putUserBoard(USER.uid, {
      boardId: "board-a", participantId: "p2", claimedAt: 1, updatedAt: 1,
    });
    expect(
      await findClaimedParticipant("board-a", USER, freshDeps),
    ).toBeNull();
    expect(
      await findClaimedParticipant("board-none", USER, freshDeps),
    ).toBeNull();
  });
});
