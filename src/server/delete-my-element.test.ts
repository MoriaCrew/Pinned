import { describe, expect, it } from "vitest";
import type { Element, Scene } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { mockElementNamer, mockSegmenter } from "../gateway/mock-ports";
import { resolvePolicy } from "../policy/policy";
import {
  createBoard,
  deleteMyElement,
  getBoardView,
  getSceneView,
  getScenesView,
  resolveElementImage,
  resolveSceneImage,
  type BoardApiDeps,
} from "./board-api";
import { joinBoard, type BoardSessionDeps } from "./board-session";
import { InMemoryDecomposeJobStore } from "./decompose-job";
import { InMemoryDerivativeStore, type DerivativeStore } from "./derivative-store";

const SECRET = "test-secret-test-secret-test-secret-32";
const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);

interface Harness {
  deps: BoardApiDeps;
  session: BoardSessionDeps;
  boards: InMemoryBoardRepository;
  store: InMemoryDerivativeStore;
}

function makeHarness(): Harness {
  const boards = new InMemoryBoardRepository();
  const store = new InMemoryDerivativeStore();
  const policy = resolvePolicy({});
  const deps: BoardApiDeps = {
    boards,
    jobs: new InMemoryDecomposeJobStore(),
    store,
    namer: mockElementNamer,
    segmenter: mockSegmenter,
    policy,
    now: () => T0,
  };
  return { deps, session: { boards, sessionSecret: SECRET, policy, now: () => T0 }, boards, store };
}

function element(over: Partial<Element>): Element {
  return {
    id: "el-1",
    boardId: "board",
    ownerId: "owner",
    label: "Brass Lamp",
    description: "a lamp",
    maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
    cutoutRef: "elements/el-1/cutout.png",
    flattenedRef: "elements/el-1/flattened.jpg",
    sourcePhotoId: "job-1",
    faceFlag: false,
    createdAt: T0,
    ...over,
  };
}

function scene(over: Partial<Scene>): Scene {
  return {
    id: "scene-1",
    boardId: "board",
    createdBy: "owner",
    elementIds: ["el-1"],
    prompt: "a lamp at a picnic",
    status: "ready",
    imageRef: "scenes/scene-1.png",
    promptVersion: "scene.v1",
    createdAt: T0,
    ...over,
  };
}

async function seed(h: Harness) {
  const board = await createBoard({ title: "Delete test" }, h.deps);
  const slug = board.slug;
  const owner = (await joinBoard(slug, { displayName: "Robin" }, null, h.session)).participant;
  const other = (await joinBoard(slug, { displayName: "Aye" }, null, h.session)).participant;
  const el1 = element({ id: "el-1", boardId: slug, ownerId: owner.id });
  const el2 = element({
    id: "el-2",
    boardId: slug,
    ownerId: owner.id,
    label: "Red Mug",
    cutoutRef: "elements/el-2/cutout.png",
    flattenedRef: "elements/el-2/flattened.jpg",
    createdAt: T0 + 1,
  });
  await h.boards.createElement(el1);
  await h.boards.createElement(el2);
  await h.boards.createPin({ id: "pin-1", boardId: slug, elementId: "el-1", pinnedBy: owner.id, status: "pinned", createdAt: T0 });
  await h.boards.createPin({ id: "pin-2", boardId: slug, elementId: "el-2", pinnedBy: owner.id, status: "pinned", createdAt: T0 + 1 });
  await h.boards.putScene(scene({ id: "scene-1", boardId: slug, createdBy: owner.id, elementIds: ["el-1"] }));
  await h.boards.putScene(scene({ id: "scene-2", boardId: slug, createdBy: owner.id, elementIds: ["el-2"], imageRef: "scenes/scene-2.png", createdAt: T0 + 1 }));
  for (const ref of [el1.cutoutRef, el1.flattenedRef, el2.cutoutRef, el2.flattenedRef, "scenes/scene-1.png", "scenes/scene-2.png"]) {
    await h.store.put(ref, Buffer.from(`bytes:${ref}`), "image/png");
  }
  return { slug, owner, other, el1, el2 };
}

describe("deleteMyElement (PIN-77)", () => {
  it("owner delete cascades: pin gone, scene hidden everywhere, counters and storage follow", async () => {
    const h = makeHarness();
    const { slug, owner, el1 } = await seed(h);
    expect(await resolveSceneImage(slug, "scene-1", h.deps)).not.toBeNull();
    const before = await getBoardView(slug, null, h.deps);
    expect(before?.activity.some((a) => a.kind === "pinned" && a.label === "Brass Lamp")).toBe(true);

    const result = await deleteMyElement(slug, owner, "el-1", h.deps);
    expect(result).toEqual({
      deleted: true,
      unpinnedOnly: false,
      removedPinIds: ["pin-1"],
      hiddenSceneIds: ["scene-1"],
      storageDeleted: true,
    });

    expect(await h.boards.getElement("el-1")).toBeNull();
    expect(await h.boards.getPin("pin-1")).toBeNull();
    expect(await h.boards.getElement("el-2")).not.toBeNull();
    expect((await h.boards.getBoard(slug))?.counters).toEqual({
      participantCount: 2,
      elementCount: 1,
      pinCount: 1,
      sceneCount: 1,
    });
    // Element objects deleted; hidden scene image object kept
    // (hidden, never served) and the surviving element intact.
    expect(await h.store.get(el1.cutoutRef)).toBeNull();
    expect(await h.store.get(el1.flattenedRef)).toBeNull();
    expect(await h.store.get("scenes/scene-1.png")).not.toBeNull();
    expect(await h.store.get("elements/el-2/cutout.png")).not.toBeNull();

    // Hidden everywhere: gallery, single scene, scene image, element image.
    expect((await getScenesView(slug, h.deps))?.scenes.map((s) => s.id)).toEqual(["scene-2"]);
    expect(await getSceneView(slug, "scene-1", h.deps)).toBeNull();
    expect(await resolveSceneImage(slug, "scene-1", h.deps)).toBeNull();
    expect(await resolveElementImage(slug, "el-1", "cutout", h.deps)).toBeNull();

    // No new public line and no new event type (PIN-77 decision):
    // the deleted pin's "pinned" line drops out of the strip.
    const after = await getBoardView(slug, null, h.deps);
    expect(after?.pins.map((p) => p.id)).toEqual(["pin-2"]);
    expect(after?.activity.some((a) => a.label === "Brass Lamp")).toBe(false);
    const types = (await h.boards.listEvents(slug)).map((e) => e.type);
    expect(types).not.toContain("element_deleted");
  });

  it("uniform 404 for non-owner, anonymous, missing and wrong-board; nothing changes", async () => {
    const h = makeHarness();
    const { slug, owner, other, el1 } = await seed(h);
    const otherBoard = await createBoard({ title: "Elsewhere" }, h.deps);

    const attempts = [
      () => deleteMyElement(slug, other, "el-1", h.deps),
      () => deleteMyElement(slug, null, "el-1", h.deps),
      () => deleteMyElement(slug, owner, "missing", h.deps),
      () => deleteMyElement(otherBoard.slug, owner, "el-1", h.deps),
      () => deleteMyElement("no-such-board", owner, "el-1", h.deps),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ name: "BoardApiError", status: 404, message: "Element not found." });
    }
    expect(await h.boards.getElement("el-1")).not.toBeNull();
    expect(await h.boards.getPin("pin-1")).not.toBeNull();
    expect(await h.store.get(el1.cutoutRef)).not.toBeNull();
    expect((await h.boards.getBoard(slug))?.counters.pinCount).toBe(2);
  });

  it("re-delete is the same uniform 404 and counters do not double-decrement", async () => {
    const h = makeHarness();
    const { slug, owner } = await seed(h);
    await deleteMyElement(slug, owner, "el-1", h.deps);
    await expect(deleteMyElement(slug, owner, "el-1", h.deps)).rejects.toMatchObject({ status: 404 });
    expect((await h.boards.getBoard(slug))?.counters).toMatchObject({
      elementCount: 1,
      pinCount: 1,
      sceneCount: 1,
    });
  });

  it("candidate (unconfirmed) element deletes too, with no pin/scene side effects", async () => {
    const h = makeHarness();
    const { slug, owner } = await seed(h);
    const cand = element({ id: "el-c", boardId: slug, ownerId: owner.id, cutoutRef: "elements/el-c/cutout.png", flattenedRef: "elements/el-c/flattened.jpg" });
    await h.boards.createElement(cand);
    await h.boards.createPin({ id: "pin-c", boardId: slug, elementId: "el-c", pinnedBy: owner.id, status: "candidate", createdAt: T0 });
    const result = await deleteMyElement(slug, owner, "el-c", h.deps);
    expect(result.deleted).toBe(true);
    expect(result.removedPinIds).toEqual(["pin-c"]);
    expect((await h.boards.getBoard(slug))?.counters.pinCount).toBe(2);
  });

  it("cross-board pin guard: unpin-only on this board, element and storage survive", async () => {
    const h = makeHarness();
    const { slug, owner, el1 } = await seed(h);
    const otherBoard = await createBoard({ title: "Elsewhere" }, h.deps);
    // A future cross-board pin is unreachable through createPin
    // today (same-board enforced), so forge the stored row.
    const pins = (h.boards as unknown as { pins: Map<string, unknown> }).pins;
    pins.set("pin-x", { id: "pin-x", boardId: otherBoard.slug, elementId: "el-1", pinnedBy: owner.id, status: "pinned", createdAt: T0 });

    const result = await deleteMyElement(slug, owner, "el-1", h.deps);
    expect(result).toMatchObject({ deleted: false, unpinnedOnly: true, removedPinIds: ["pin-1"], hiddenSceneIds: ["scene-1"], storageDeleted: false });
    expect(await h.boards.getElement("el-1")).not.toBeNull();
    expect(await h.boards.getPin("pin-x")).not.toBeNull();
    expect(await h.store.get(el1.cutoutRef)).not.toBeNull();
    expect(await getSceneView(slug, "scene-1", h.deps)).toBeNull();
  });

  it("storage cleanup is best-effort and never touches refs outside elements/", async () => {
    const h = makeHarness();
    const { slug, owner } = await seed(h);
    const forged = element({
      id: "el-f",
      boardId: slug,
      ownerId: owner.id,
      cutoutRef: "tmp/boards/secret/working.webp",
      flattenedRef: "elements/el-f/flattened.jpg",
    });
    await h.boards.createElement(forged);
    await h.store.put("tmp/boards/secret/working.webp", Buffer.from("secret"), "image/webp");
    await h.store.put("elements/el-f/flattened.jpg", Buffer.from("flat"), "image/jpeg");
    // A failing delete must not fail the request.
    const flaky: DerivativeStore = {
      put: (ref, bytes, type) => h.store.put(ref, bytes, type),
      get: (ref) => h.store.get(ref),
      delete: async (ref) => {
        if (ref === "elements/el-f/flattened.jpg") throw new Error("gcs down");
        return h.store.delete(ref);
      },
    };
    const result = await deleteMyElement(slug, owner, "el-f", { ...h.deps, store: flaky });
    expect(result.deleted).toBe(true);
    expect(await h.store.get("tmp/boards/secret/working.webp")).not.toBeNull();
    expect(await h.boards.getElement("el-f")).toBeNull();
  });
});
