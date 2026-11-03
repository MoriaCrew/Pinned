import { describe, expect, it, vi } from "vitest";
import { emptyBoardCounters, type Board } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { InMemoryCreditLedgerStore } from "../domain/credit-ledger";
import { InMemoryStarterAllowanceStore } from "../domain/starter-allowance";
import { generateSlug, isValidSlug } from "../domain/tokens";
import { resolvePolicy } from "../policy/policy";
import { BoardApiError } from "./board-session";
import { readAvailableMakes } from "./credit-pool";
import { DEMO_CAPPED, DEMO_UNAVAILABLE, createDemoBoard, type DemoBoardDeps } from "./demo-board";
import { InMemoryDerivativeStore } from "./derivative-store";
import { verifyHostToken } from "./host-session";

/**
 * createDemoBoard (PIN-251): a visitor gets a fresh, hosted, free copy
 * of the template; the template is only read; every brake fails closed.
 */
const TEMPLATE = "tmplAAAAAAAAAAAAAAAAA1";
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const SCENE_BYTES = Buffer.from("scene-png");

const policy = resolvePolicy({
  credits: { enabled: true, starterMakes: 20, freePhotosPerBoard: 15 },
  demo: { ttlHours: 1, starterMakes: 2, freePhotos: 3, maxPerIp: 2, maxTotal: 3, windowMs: 24 * HOUR },
});

async function harness(overrides: Partial<DemoBoardDeps> = {}) {
  const boards = new InMemoryBoardRepository();
  const store = new InMemoryDerivativeStore();
  const credits = new InMemoryCreditLedgerStore();
  const starterAllowance = new InMemoryStarterAllowanceStore();
  const deps: DemoBoardDeps = { boards, store, credits, starterAllowance, policy, now: () => NOW, ...overrides };

  const template: Board = {
    slug: TEMPLATE,
    title: "Pinneds demo board (seeded, synthetic)",
    themeId: "cat",
    host: { tokenHash: "template-host", issuedAt: 1 },
    policyOverrides: { participantsPerBoard: 500 },
    starterMakes: 20,
    freePhotos: 15,
    counters: emptyBoardCounters(),
    createdAt: 1_000,
    version: 1,
  };
  await boards.createBoard(template);
  await boards.putParticipant({ id: "p1", boardId: TEMPLATE, displayName: "Demo Mia", cookieSecretHash: "h1", userId: "uid-mia", createdAt: 1_100 });
  await boards.putParticipant({ id: "p2", boardId: TEMPLATE, displayName: "Demo Sam", cookieSecretHash: "h2", createdAt: 1_101 });
  const el = (id: string, ownerId: string) => ({
    id, boardId: TEMPLATE, ownerId, label: id, description: id, maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
    cutoutRef: `elements/boards/${TEMPLATE}/${id}/cutout.png`, flattenedRef: `elements/boards/${TEMPLATE}/${id}/flattened.jpg`,
    sourcePhotoId: `job-${id}`, faceFlag: false, createdAt: 1_200,
  });
  for (const e of [el("e1", "p1"), el("e2", "p2"), el("e3", "p2")]) {
    await boards.createElement(e);
    await store.put(e.cutoutRef, Buffer.from(e.id), "image/png");
    await store.put(e.flattenedRef, Buffer.from(e.id), "image/jpeg");
  }
  await boards.createPin({ id: "pin1", boardId: TEMPLATE, elementId: "e1", pinnedBy: "p1", status: "pinned", createdAt: 1_300 });
  await boards.createPin({ id: "pin2", boardId: TEMPLATE, elementId: "e2", pinnedBy: "p2", status: "pinned", createdAt: 1_300 });
  await boards.createPin({ id: "pin3", boardId: TEMPLATE, elementId: "e3", pinnedBy: "p2", status: "candidate", createdAt: 1_300 });
  const imageRef = `scenes/boards/${TEMPLATE}/s1/scene.png`;
  await store.put(imageRef, SCENE_BYTES, "image/png");
  await boards.putScene({
    id: "s1", boardId: TEMPLATE, createdBy: "p1", elementIds: ["e1", "e2"], prompt: "tea party", status: "ready",
    imageRef, width: 1024, height: 1536, promptVersion: "scene.v1", kind: "ai", costUsd: 0.04, createdAt: 1_400,
  });

  const snapshot = async (slug: string) => ({
    board: await boards.getBoard(slug),
    participants: await boards.listParticipants(slug),
    elements: await boards.listElements(slug),
    pins: await boards.listPins(slug),
    scenes: await boards.listScenes(slug, { includeHidden: true }),
    files: (await Promise.all(["tmp", "elements", "scenes"].map((root) => store.listPrefix(`${root}/boards/${slug}/`)))).flat(),
  });
  const create = (clientKey = "visitor-a") => createDemoBoard({ templateSlug: TEMPLATE, title: "Demo board", clientKey }, deps);
  return { boards, store, credits, starterAllowance, deps, snapshot, create };
}

describe("createDemoBoard (PIN-251)", () => {
  it("gives the visitor a fresh, hosted, free copy with the demo pool, and leaves the template alone", async () => {
    const h = await harness();
    const before = await h.snapshot(TEMPLATE);
    const { board, hostToken } = await h.create();

    expect(isValidSlug(board.slug)).toBe(true);
    expect(board.slug).not.toBe(TEMPLATE);
    expect(verifyHostToken(board, hostToken, policy, NOW)).toBe(true);
    expect(verifyHostToken(before.board!, hostToken, policy, NOW)).toBe(false);
    expect(board).toMatchObject({
      title: "Demo board",
      themeId: "cat",
      starterMakes: 2,
      freePhotos: 3,
      demo: { templateSlug: TEMPLATE, expiresAt: NOW + HOUR },
      demoSweepAt: NOW + HOUR,
      createdAt: NOW,
    });
    expect(board).not.toHaveProperty("policyOverrides");
    expect(board).not.toHaveProperty("plus");

    const clone = await h.snapshot(board.slug);
    expect(clone.board?.counters).toEqual({ participantCount: 2, elementCount: 2, pinCount: 2, sceneCount: 1 });
    expect(clone.participants.map((p) => p.displayName)).toEqual(["Demo Mia", "Demo Sam"]);
    for (const p of clone.participants) {
      expect(p).not.toHaveProperty("userId");
      expect(["h1", "h2"]).not.toContain(p.cookieSecretHash);
    }
    // Cut-outs are shared with the template (no new element files); the scene picture is the clone's own copy.
    expect(clone.elements.map((e) => e.cutoutRef)).toEqual([
      `elements/boards/${TEMPLATE}/e1/cutout.png`,
      `elements/boards/${TEMPLATE}/e2/cutout.png`,
    ]);
    expect(clone.pins.every((p) => p.status === "pinned")).toBe(true);
    expect(clone.scenes).toHaveLength(1);
    expect(clone.scenes[0].imageRef).toBe(`scenes/boards/${board.slug}/${clone.scenes[0].id}/scene.png`);
    expect(clone.files).toEqual([clone.scenes[0].imageRef]);
    expect(await h.store.get(clone.scenes[0].imageRef as string)).toEqual(SCENE_BYTES);
    // The pool is Policy.demo.starterMakes, never credits.starterMakes.
    expect(await readAvailableMakes(board.slug, h.deps)).toBe(2);
    expect(await readAvailableMakes(TEMPLATE, h.deps)).toBe(20);

    expect(await h.snapshot(TEMPLATE)).toEqual(before);
  });

  it("two visitors get two different live boards", async () => {
    const h = await harness();
    const a = await h.create("visitor-a");
    const b = await h.create("visitor-b");
    expect(a.board.slug).not.toBe(b.board.slug);
    expect(await h.boards.getBoard(a.board.slug)).not.toBeNull();
    expect(await h.boards.getBoard(b.board.slug)).not.toBeNull();
  });

  it("refuses past the per-address cap, then past the total cap, recording nothing", async () => {
    const h = await harness();
    await h.create("visitor-a");
    await h.create("visitor-a");
    await expect(h.create("visitor-a")).rejects.toMatchObject({ status: 429, code: DEMO_CAPPED });
    await h.create("visitor-b"); // total 3 reached
    await expect(h.create("visitor-c")).rejects.toMatchObject({ status: 429, code: DEMO_CAPPED });
    await expect(h.create("visitor-c")).rejects.toBeInstanceOf(BoardApiError);
    // Exactly three boards exist beside the template.
    expect(await h.boards.listDemoBoardsToSweep(NOW + 2 * HOUR, 10)).toHaveLength(3);
  });

  it("fails closed without a durable counter, when the counter errors, and when a cap is 0", async () => {
    const noStore = await harness({ starterAllowance: undefined });
    await expect(noStore.create()).rejects.toMatchObject({ status: 429, code: DEMO_CAPPED });

    const erroring = await harness();
    vi.spyOn(erroring.starterAllowance, "tryClaim").mockRejectedValue(new Error("firestore down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(erroring.create()).rejects.toMatchObject({ status: 429, code: DEMO_CAPPED });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();

    const closed = await harness({ policy: resolvePolicy({ demo: { maxPerIp: 0 } }) });
    await expect(closed.create()).rejects.toMatchObject({ status: 429, code: DEMO_CAPPED });
    for (const h of [noStore, erroring, closed]) {
      expect(await h.boards.listDemoBoardsToSweep(NOW + 48 * HOUR, 10)).toEqual([]);
    }
  });

  it("a missing template is unavailable, and spends no slot", async () => {
    const h = await harness();
    await expect(
      createDemoBoard({ templateSlug: generateSlug(), title: "Demo board", clientKey: "visitor-a" }, h.deps),
    ).rejects.toMatchObject({ status: 503, code: DEMO_UNAVAILABLE });
    await h.create("visitor-a");
    await h.create("visitor-a"); // both per-address slots still there
  });

  it("rolls a half-made board back: tombstoned, its storage swept, the template's files kept", async () => {
    const slug = generateSlug();
    const h = await harness({ createSlug: () => slug });
    vi.spyOn(h.boards, "createPin").mockRejectedValueOnce(new Error("firestore hiccup"));
    await expect(h.create()).rejects.toThrow("firestore hiccup");
    const clone = await h.snapshot(slug);
    expect(clone.board).toBeNull();
    expect(clone.files).toEqual([]);
    expect(await h.boards.listDemoBoardsToSweep(NOW + 48 * HOUR, 10)).toEqual([]);
    const template = await h.snapshot(TEMPLATE);
    expect(template.files).toHaveLength(7);
    expect(template.board).not.toBeNull();
  });

  it("a scene whose picture could not be copied is left out; the board still lands", async () => {
    const h = await harness();
    vi.spyOn(h.store, "copy").mockRejectedValue(new Error("gcs down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { board } = await h.create();
    const clone = await h.snapshot(board.slug);
    expect(clone.scenes).toEqual([]);
    expect(clone.board?.counters.sceneCount).toBe(0);
    expect(clone.pins).toHaveLength(2);
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toContain(TEMPLATE);
    errors.mockRestore();
  });

  it("with credits off, the board still stores the demo pool and no ledger is touched", async () => {
    const h = await harness({ policy: resolvePolicy({ demo: { starterMakes: 2 } }) });
    const { board } = await h.create();
    expect(board.starterMakes).toBe(2);
    expect(await readAvailableMakes(board.slug, h.deps)).toBeNull();
    expect(await h.credits.getAccount(board.slug)).toBeNull();
  });
});
