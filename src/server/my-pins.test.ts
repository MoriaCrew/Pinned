import { describe, expect, it } from "vitest";
import type { Element, Participant, Scene } from "../domain/board";
import { emptyBoardCounters } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import type { UserProfile } from "../domain/user";
import { InMemoryUserRepository } from "../domain/user-repository";
import type { ComposeSceneInput, SceneComposer } from "../gateway/ports";
import { mockElementNamer, mockSegmenter } from "../gateway/mock-ports";
import { resolvePolicy } from "../policy/policy";
import { deleteMyElement, type BoardApiDeps } from "./board-api";
import { BoardApiError } from "./board-session";
import { InMemoryDecomposeJobStore } from "./decompose-job";
import { InMemoryDerivativeStore } from "./derivative-store";
import {
  libraryCopyId,
  listMyElements,
  parsePinFromLibraryInput,
  pinFromLibrary,
  resolveOwnedElementImage,
  type MyPinsDeps,
} from "./my-pins";
import { InMemorySceneJobStore, startSceneJob, type SceneJobDeps } from "./scene-job";

const ALICE: UserProfile = { uid: "synthetic-alice", createdAt: 1, updatedAt: 1 };
const BOB: UserProfile = { uid: "synthetic-bob", createdAt: 1, updatedAt: 1 };
const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";

function participant(id: string, boardId: string, userId?: string): Participant {
  return {
    id,
    boardId,
    displayName: id,
    cookieSecretHash: "hash",
    ...(userId ? { userId } : {}),
    createdAt: 1,
  };
}

function element(over: Partial<Element> & Pick<Element, "id" | "boardId" | "ownerId">): Element {
  return {
    label: over.id,
    description: "",
    maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
    cutoutRef: `elements/${over.id}/cutout.png`,
    flattenedRef: `elements/${over.id}/flattened.jpg`,
    sourcePhotoId: "photo-1",
    faceFlag: false,
    createdAt: T0,
    ...over,
  };
}

interface Harness {
  boards: InMemoryBoardRepository;
  users: InMemoryUserRepository;
  store: InMemoryDerivativeStore;
  pins: MyPinsDeps;
  api: BoardApiDeps;
  sceneDeps: SceneJobDeps;
  calls: ComposeSceneInput[];
  aliceOnA: Participant;
  aliceOnB: Participant;
  bobOnA: Participant;
}

async function makeHarness(): Promise<Harness> {
  const boards = new InMemoryBoardRepository();
  const users = new InMemoryUserRepository();
  const store = new InMemoryDerivativeStore();
  const policy = resolvePolicy({});
  await users.putUser(ALICE);
  await users.putUser(BOB);
  for (const [slug, title] of [
    ["board-a-secret-slug-a", "Kitchen chaos"],
    ["board-b-secret-slug-b", "Beach day"],
    ["board-c-secret-slug-c", "Stale board"],
  ] as const) {
    await boards.createBoard({
      slug,
      title,
      counters: emptyBoardCounters(),
      createdAt: 1,
      version: 1,
    });
  }
  const aliceOnA = participant("pa", "board-a-secret-slug-a", ALICE.uid);
  const aliceOnB = participant("pb", "board-b-secret-slug-b", ALICE.uid);
  const bobOnA = participant("pc", "board-a-secret-slug-a", BOB.uid);
  // On board C alice's index entry is stale: the participant is bob's now.
  await boards.putParticipant(aliceOnA);
  await boards.putParticipant(aliceOnB);
  await boards.putParticipant(bobOnA);
  await boards.putParticipant(participant("pd", "board-c-secret-slug-c", BOB.uid));
  for (const [uid, boardId, participantId] of [
    [ALICE.uid, "board-a-secret-slug-a", "pa"],
    [ALICE.uid, "board-b-secret-slug-b", "pb"],
    [ALICE.uid, "board-c-secret-slug-c", "pd"],
    [ALICE.uid, "board-gone", "px"],
    [BOB.uid, "board-a-secret-slug-a", "pc"],
  ] as const) {
    await users.putUserBoard(uid, { boardId, participantId, claimedAt: 1, updatedAt: 1 });
  }

  const lamp = element({
    id: "el-lamp",
    boardId: "board-a-secret-slug-a",
    ownerId: "pa",
    label: "Brass Lamp",
    createdAt: T0 + 3,
  });
  const mug = element({
    id: "el-mug",
    boardId: "board-b-secret-slug-b",
    ownerId: "pb",
    label: "Red Mug",
    createdAt: T0 + 5,
  });
  const bobs = element({
    id: "el-bobs",
    boardId: "board-a-secret-slug-a",
    ownerId: "pc",
    label: "Bob Hat",
    createdAt: T0 + 9,
  });
  const stale = element({
    id: "el-stale",
    boardId: "board-c-secret-slug-c",
    ownerId: "pd",
    label: "Stale Thing",
    createdAt: T0 + 7,
  });
  for (const el of [lamp, mug, bobs, stale]) {
    await boards.createElement(el);
    await store.put(el.cutoutRef, Buffer.from(PNG_B64, "base64"), "image/png");
    await store.put(el.flattenedRef, Buffer.from(`flat:${el.id}`), "image/jpeg");
  }
  await boards.createPin({
    id: "pin-lamp",
    boardId: lamp.boardId,
    elementId: lamp.id,
    pinnedBy: "pa",
    status: "pinned",
    createdAt: T0 + 4,
  });
  await boards.createPin({
    id: "pin-mug",
    boardId: mug.boardId,
    elementId: mug.id,
    pinnedBy: "pb",
    status: "pinned",
    createdAt: T0 + 6,
  });
  await boards.createPin({
    id: "pin-bobs",
    boardId: bobs.boardId,
    elementId: bobs.id,
    pinnedBy: "pc",
    status: "pinned",
    createdAt: T0 + 10,
  });

  let seq = 0;
  const newId = () => `gen-${++seq}`;
  const calls: ComposeSceneInput[] = [];
  const composer: SceneComposer = {
    async composeScene(input) {
      calls.push(structuredClone(input));
      return {
        status: "ready",
        value: { imageBase64: PNG_B64, promptVersion: input.promptVersion },
      };
    },
  };
  const sceneJobs = new InMemorySceneJobStore();
  return {
    boards,
    users,
    store,
    pins: { boards, users, policy, now: () => T0 + 100, newId },
    api: {
      boards,
      jobs: new InMemoryDecomposeJobStore(),
      store,
      namer: mockElementNamer,
      segmenter: mockSegmenter,
      sceneJobs,
      composer,
      policy,
      now: () => T0 + 100,
      newId,
    },
    sceneDeps: {
      boards,
      jobs: sceneJobs,
      store,
      composer,
      policy,
      now: () => T0 + 100,
      newId,
    },
    calls,
    aliceOnA,
    aliceOnB,
    bobOnA,
  };
}

describe("listMyElements (PIN-85)", () => {
  it("collects owned elements across claimed boards, newest first, title labels only", async () => {
    const h = await makeHarness();
    const page = await listMyElements(ALICE, h.pins);
    expect(page.total).toBe(2);
    expect(page.limit).toBe(60);
    expect(page.elements.map((c) => c.elementId)).toEqual(["el-mug", "el-lamp"]);
    expect(page.elements[0]).toMatchObject({
      label: "Red Mug",
      sourceBoardTitle: "Beach day",
      imageUrl: "/api/me/elements/el-mug/image?kind=cutout",
    });
    // No capability slug anywhere in the library payload.
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("secret-slug");
    // Bob sees only his own element; stale/gone index entries skip.
    const bobs = await listMyElements(BOB, h.pins);
    expect(bobs.elements.map((c) => c.elementId)).toEqual(["el-bobs"]);
  });

  it("tags every card with its family: a copy points at its original (PIN-121)", async () => {
    const h = await makeHarness();
    const copy = await pinFromLibrary("board-b-secret-slug-b", h.aliceOnB, ALICE, "el-lamp", h.pins);
    const page = await listMyElements(ALICE, h.pins);
    const families = Object.fromEntries(page.elements.map((c) => [c.elementId, c.familyId]));
    expect(families).toEqual({
      [copy.elementId]: "el-lamp",
      "el-lamp": "el-lamp",
      "el-mug": "el-mug",
    });
    // Still no capability slug in the payload.
    expect(JSON.stringify(page)).not.toContain("secret-slug");
  });

  it("lists pinned things only: candidates in review, left out or cleared stay out (PIN-125)", async () => {
    const h = await makeHarness();
    const board = "board-a-secret-slug-a";
    // Still in review: a candidate pin.
    await h.boards.createElement(element({ id: "el-review", boardId: board, ownerId: "pa", createdAt: T0 + 20 }));
    await h.boards.createPin({ id: "pin-review", boardId: board, elementId: "el-review", pinnedBy: "pa", status: "candidate", createdAt: T0 + 20 });
    // Left out or cleared: confirm deleted its pin, the element stays.
    await h.boards.createElement(element({ id: "el-cleared", boardId: board, ownerId: "pa", createdAt: T0 + 21 }));
    await h.boards.createPin({ id: "pin-cleared", boardId: board, elementId: "el-cleared", pinnedBy: "pa", status: "candidate", createdAt: T0 + 21 });
    expect(await h.boards.deletePin("pin-cleared")).toBe(true);
    // A library copy is pinned, so it is listed.
    const copy = await pinFromLibrary("board-b-secret-slug-b", h.aliceOnB, ALICE, "el-lamp", h.pins);

    const page = await listMyElements(ALICE, h.pins);
    const ids = page.elements.map((c) => c.elementId);
    expect(ids).not.toContain("el-review");
    expect(ids).not.toContain("el-cleared");
    expect(ids).toEqual(expect.arrayContaining(["el-lamp", "el-mug", copy.elementId]));
    expect(page.total).toBe(3);

    // Pinning the candidate later brings it in.
    await h.boards.setPinStatus("pin-review", "pinned", T0 + 30);
    const after = await listMyElements(ALICE, h.pins);
    expect(after.elements.map((c) => c.elementId)).toContain("el-review");
  });

  it("clamps the limit to Policy.libraryPageSize", async () => {
    const h = await makeHarness();
    const one = await listMyElements(ALICE, h.pins, 1);
    expect(one).toMatchObject({ total: 2, limit: 1 });
    expect(one.elements.map((c) => c.elementId)).toEqual(["el-mug"]);
    const huge = await listMyElements(ALICE, h.pins, 10_000);
    expect(huge.limit).toBe(60);
    expect(huge.elements).toHaveLength(2);
  });
});

describe("resolveOwnedElementImage (PIN-85)", () => {
  it("serves the owner; every other case is the uniform null (404)", async () => {
    const h = await makeHarness();
    const deps = { boards: h.boards, store: h.store };
    const image = await resolveOwnedElementImage(ALICE, "el-lamp", "cutout", deps);
    expect(image?.contentType).toBe("image/png");
    expect(image?.bytes.equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
    // Another user's element, signed out, unknown id, bad kind.
    expect(await resolveOwnedElementImage(BOB, "el-lamp", "cutout", deps)).toBeNull();
    expect(await resolveOwnedElementImage(null, "el-lamp", "cutout", deps)).toBeNull();
    expect(await resolveOwnedElementImage(ALICE, "el-nope", "cutout", deps)).toBeNull();
    expect(await resolveOwnedElementImage(ALICE, "el-lamp", "raw", deps)).toBeNull();
    expect(await resolveOwnedElementImage(ALICE, "el-lamp", null, deps)).toBeNull();
  });
});

describe("pinFromLibrary (PIN-85 copy semantics)", () => {
  it("copies cross-board with shared refs + provenance, pins as the current participant", async () => {
    const h = await makeHarness();
    const result = await pinFromLibrary(
      "board-b-secret-slug-b",
      h.aliceOnB,
      ALICE,
      "el-lamp",
      h.pins,
    );
    expect(result.alreadyPinned).toBe(false);
    expect(result.pin).toMatchObject({
      boardId: "board-b-secret-slug-b",
      pinnedBy: "pb",
      status: "pinned",
    });
    const copy = await h.boards.getElement(result.elementId);
    expect(copy?.id).not.toBe("el-lamp");
    expect(copy).toMatchObject({
      boardId: "board-b-secret-slug-b",
      ownerId: "pb",
      label: "Brass Lamp",
      cutoutRef: "elements/el-lamp/cutout.png",
      flattenedRef: "elements/el-lamp/flattened.jpg",
      sourceElementId: "el-lamp",
    });
    expect(await h.boards.listElementsBySource("el-lamp")).toHaveLength(1);
    // It is a native citizen of board B now.
    const pinsOnB = await h.boards.listPins("board-b-secret-slug-b", "pinned");
    expect(pinsOnB.map((p) => p.elementId).sort()).toEqual(
      ["el-mug", result.elementId].sort(),
    );
  });

  it("repeat pin is the friendly alreadyPinned no-op (one copy, one pin)", async () => {
    const h = await makeHarness();
    const first = await pinFromLibrary("board-b-secret-slug-b", h.aliceOnB, ALICE, "el-lamp", h.pins);
    const second = await pinFromLibrary("board-b-secret-slug-b", h.aliceOnB, ALICE, "el-lamp", h.pins);
    expect(second.alreadyPinned).toBe(true);
    expect(second.pin.id).toBe(first.pin.id);
    expect(second.elementId).toBe(first.elementId);
    expect(await h.boards.listElementsBySource("el-lamp")).toHaveLength(1);
    expect(await h.boards.listPinsForElement(first.elementId)).toHaveLength(1);
  });

  it("same-board library element pins natively, promoting a candidate", async () => {
    const h = await makeHarness();
    // Lamp already pinned on A: friendly no-op, no copy.
    const again = await pinFromLibrary("board-a-secret-slug-a", h.aliceOnA, ALICE, "el-lamp", h.pins);
    expect(again).toMatchObject({ alreadyPinned: true, elementId: "el-lamp" });
    expect(await h.boards.listElementsBySource("el-lamp")).toHaveLength(0);

    // A candidate element of mine on the same board gets promoted.
    await h.boards.createElement(
      element({ id: "el-cand", boardId: "board-a-secret-slug-a", ownerId: "pa" }),
    );
    await h.boards.createPin({
      id: "pin-cand",
      boardId: "board-a-secret-slug-a",
      elementId: "el-cand",
      pinnedBy: "pa",
      status: "candidate",
      createdAt: T0 + 8,
    });
    const promoted = await pinFromLibrary("board-a-secret-slug-a", h.aliceOnA, ALICE, "el-cand", h.pins);
    expect(promoted).toMatchObject({ alreadyPinned: false, elementId: "el-cand" });
    expect(promoted.pin.status).toBe("pinned");
  });

  it("uniform 404: other user's element, unknown element, no/wrong-board participant", async () => {
    const h = await makeHarness();
    const is404 = (error: unknown) =>
      error instanceof BoardApiError && error.status === 404;
    await expect(
      pinFromLibrary("board-b-secret-slug-b", h.aliceOnB, ALICE, "el-bobs", h.pins),
    ).rejects.toSatisfy(is404);
    await expect(
      pinFromLibrary("board-b-secret-slug-b", h.aliceOnB, ALICE, "el-nope", h.pins),
    ).rejects.toSatisfy(is404);
    await expect(
      pinFromLibrary("board-b-secret-slug-b", null, ALICE, "el-lamp", h.pins),
    ).rejects.toSatisfy(is404);
    // Alice's board-A participant cookie does not pin onto board B.
    await expect(
      pinFromLibrary("board-b-secret-slug-b", h.aliceOnA, ALICE, "el-lamp", h.pins),
    ).rejects.toSatisfy(is404);
    expect(await h.boards.listElementsBySource("el-lamp")).toHaveLength(0);
  });

  it("copy ids are deterministic per (board, source) and leak neither", async () => {
    const h = await makeHarness();
    const id = libraryCopyId("board-b-secret-slug-b", "el-lamp");
    expect(id).toBe(libraryCopyId("board-b-secret-slug-b", "el-lamp"));
    expect(id).not.toBe(libraryCopyId("board-a-secret-slug-a", "el-lamp"));
    expect(id).not.toContain("secret-slug");
    expect(id).not.toContain("el-lamp");
    const result = await pinFromLibrary(
      "board-b-secret-slug-b",
      h.aliceOnB,
      ALICE,
      "el-lamp",
      h.pins,
    );
    expect(result.elementId).toBe(id);
    // Concurrent double-pin resolves to one copy + one pin.
    const h2 = await makeHarness();
    const [one, two] = await Promise.all([
      pinFromLibrary("board-b-secret-slug-b", h2.aliceOnB, ALICE, "el-lamp", h2.pins),
      pinFromLibrary("board-b-secret-slug-b", h2.aliceOnB, ALICE, "el-lamp", h2.pins),
    ]);
    expect(one.elementId).toBe(two.elementId);
    expect(await h2.boards.listElementsBySource("el-lamp")).toHaveLength(1);
    expect(await h2.boards.listPinsForElement(one.elementId)).toHaveLength(1);
  });

  it("family dedupe: pinning a sibling copy or back to the root board is alreadyPinned (Bugbot PR74)", async () => {
    const h = await makeHarness();
    // Fourth board where alice also participates + is claimed.
    await h.boards.createBoard({
      slug: "board-d-secret-slug-d",
      title: "Fourth",
      counters: emptyBoardCounters(),
      createdAt: 1,
      version: 1,
    });
    const aliceOnD = participant("pe", "board-d-secret-slug-d", ALICE.uid);
    await h.boards.putParticipant(aliceOnD);
    await h.users.putUserBoard(ALICE.uid, {
      boardId: "board-d-secret-slug-d",
      participantId: "pe",
      claimedAt: 1,
      updatedAt: 1,
    });

    const onB = await pinFromLibrary("board-b-secret-slug-b", h.aliceOnB, ALICE, "el-lamp", h.pins);
    const onD = await pinFromLibrary("board-d-secret-slug-d", aliceOnD, ALICE, "el-lamp", h.pins);
    expect(onD.elementId).not.toBe(onB.elementId);

    // Tapping the board-D copy's library card while on board B:
    // same family (root el-lamp) already there, no second copy.
    const viaSibling = await pinFromLibrary(
      "board-b-secret-slug-b",
      h.aliceOnB,
      ALICE,
      onD.elementId,
      h.pins,
    );
    expect(viaSibling).toMatchObject({ alreadyPinned: true, elementId: onB.elementId });
    expect(await h.boards.listElements("board-b-secret-slug-b")).toHaveLength(2);
    // Copies always provenance-point at the root, never chained.
    expect((await h.boards.getElement(onD.elementId))?.sourceElementId).toBe("el-lamp");

    // Tapping the board-B copy while on the root's board A: the
    // root's own pin answers, alreadyPinned.
    const backHome = await pinFromLibrary(
      "board-a-secret-slug-a",
      h.aliceOnA,
      ALICE,
      onB.elementId,
      h.pins,
    );
    expect(backHome).toMatchObject({ alreadyPinned: true, elementId: "el-lamp" });
  });

  it("parsePinFromLibraryInput rejects malformed bodies", () => {
    expect(parsePinFromLibraryInput({ elementId: "x" })).toEqual({ elementId: "x" });
    expect(() => parsePinFromLibraryInput(null)).toThrow(BoardApiError);
    expect(() => parsePinFromLibraryInput({})).toThrow(BoardApiError);
    expect(() => parsePinFromLibraryInput({ elementId: 7 })).toThrow(BoardApiError);
  });
});

describe("library pin in scenes, remix and delete cascade (PIN-85)", () => {
  function scene(over: Partial<Scene> & Pick<Scene, "id" | "boardId" | "elementIds">): Scene {
    return {
      createdBy: "pa",
      prompt: "a scene",
      status: "ready",
      imageRef: `scenes/${over.id}.png`,
      promptVersion: "scene.v1",
      createdAt: T0 + 50,
      ...over,
    };
  }

  it("composes in a scene on the target board like a native pin", async () => {
    const h = await makeHarness();
    const { elementId: copyId } = await pinFromLibrary(
      "board-b-secret-slug-b",
      h.aliceOnB,
      ALICE,
      "el-lamp",
      h.pins,
    );
    const job = await startSceneJob(
      {
        boardId: "board-b-secret-slug-b",
        participantId: "pb",
        elementIds: [copyId, "el-mug"],
        prompt: "on a sunny picnic blanket",
      },
      h.sceneDeps,
    );
    expect(job.status).toBe("ready");
    const stored = await h.boards.getScene(job.id);
    expect(stored?.elementIds).toEqual([copyId, "el-mug"]);
    // The composer received the copy's (shared) flattened bytes.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].elements.map((e) => e.label)).toEqual(
      expect.arrayContaining(["Brass Lamp", "Red Mug"]),
    );

    // Remix credit includes the copy: a remix child snapshotted
    // with the parent carries copyId in its cascade set.
    const remix = await startSceneJob(
      {
        boardId: "board-b-secret-slug-b",
        participantId: "pb",
        parentSceneId: job.id,
        elementIds: ["el-mug"],
        prompt: "now in space",
      },
      h.sceneDeps,
    );
    const remixScene = await h.boards.getScene(remix.id);
    expect(remixScene?.elementIds).toContain(copyId);

    // Deleting the copy (PIN-77 path, owner = current board
    // participant) hides both scenes; the shared assets survive
    // because the source element still lives on board A.
    const deleted = await deleteMyElement(
      "board-b-secret-slug-b",
      h.aliceOnB,
      copyId,
      h.api,
    );
    expect(deleted.deleted).toBe(true);
    expect(deleted.storageDeleted).toBe(false);
    expect([...deleted.hiddenSceneIds].sort()).toEqual([job.id, remix.id].sort());
    expect(await h.store.get("elements/el-lamp/cutout.png")).not.toBeNull();
    expect(await h.boards.getElement("el-lamp")).not.toBeNull();
  });

  it("deleting the original hides its scenes but the copy + shared assets survive; last delete frees storage", async () => {
    const h = await makeHarness();
    const { elementId: copyId } = await pinFromLibrary(
      "board-b-secret-slug-b",
      h.aliceOnB,
      ALICE,
      "el-lamp",
      h.pins,
    );
    await h.boards.putScene(
      scene({ id: "scene-a", boardId: "board-a-secret-slug-a", elementIds: ["el-lamp"] }),
    );
    await h.boards.putScene(
      scene({
        id: "scene-b",
        boardId: "board-b-secret-slug-b",
        createdBy: "pb",
        elementIds: [copyId],
      }),
    );

    const deleted = await deleteMyElement("board-a-secret-slug-a", h.aliceOnA, "el-lamp", h.api);
    expect(deleted).toMatchObject({ deleted: true, storageDeleted: false });
    expect(deleted.hiddenSceneIds).toEqual(["scene-a"]);
    // Copy on B is untouched and its scene still shows.
    expect(await h.boards.getElement(copyId)).not.toBeNull();
    expect((await h.boards.getScene("scene-b"))?.hidden).toBeUndefined();
    expect(await h.boards.listPinsForElement(copyId)).toHaveLength(1);
    expect(await h.store.get("elements/el-lamp/cutout.png")).not.toBeNull();

    // Deleting the copy afterwards is the last record out: its
    // scene hides on B and the shared objects are finally freed.
    const deletedCopy = await deleteMyElement("board-b-secret-slug-b", h.aliceOnB, copyId, h.api);
    expect(deletedCopy).toMatchObject({ deleted: true, storageDeleted: true });
    expect(deletedCopy.hiddenSceneIds).toEqual(["scene-b"]);
    expect(await h.store.get("elements/el-lamp/cutout.png")).toBeNull();
  });

  it("sibling copies keep shared assets until the LAST family record goes (Bugbot PR74 High)", async () => {
    const h = await makeHarness();
    await h.boards.createBoard({
      slug: "board-d-secret-slug-d",
      title: "Fourth",
      counters: emptyBoardCounters(),
      createdAt: 1,
      version: 1,
    });
    const aliceOnD = participant("pe", "board-d-secret-slug-d", ALICE.uid);
    await h.boards.putParticipant(aliceOnD);
    await h.users.putUserBoard(ALICE.uid, {
      boardId: "board-d-secret-slug-d",
      participantId: "pe",
      claimedAt: 1,
      updatedAt: 1,
    });
    const onB = await pinFromLibrary("board-b-secret-slug-b", h.aliceOnB, ALICE, "el-lamp", h.pins);
    const onD = await pinFromLibrary("board-d-secret-slug-d", aliceOnD, ALICE, "el-lamp", h.pins);

    // Original goes first: assets survive for both siblings.
    const delRoot = await deleteMyElement("board-a-secret-slug-a", h.aliceOnA, "el-lamp", h.api);
    expect(delRoot.storageDeleted).toBe(false);
    // One sibling goes: the other sibling still needs the bytes.
    const delB = await deleteMyElement("board-b-secret-slug-b", h.aliceOnB, onB.elementId, h.api);
    expect(delB.storageDeleted).toBe(false);
    expect(await h.store.get("elements/el-lamp/cutout.png")).not.toBeNull();
    expect(await h.boards.getElement(onD.elementId)).not.toBeNull();
    // Last family record out frees the objects.
    const delD = await deleteMyElement("board-d-secret-slug-d", aliceOnD, onD.elementId, h.api);
    expect(delD.storageDeleted).toBe(true);
    expect(await h.store.get("elements/el-lamp/cutout.png")).toBeNull();
  });
});
