/**
 * Shared BoardRepository contract suite (PIN-62). Every
 * implementation runs this: the in-memory one here, the Firestore
 * one in PIN-53a-fs. Assertions avoid implementation specifics
 * (generated event ids are only checked non-empty + unique).
 */
import { describe, expect, it } from "vitest";
import {
  emptyBoardCounters,
  type Board,
  type Element,
  type Participant,
  type Pin,
  type Scene,
} from "./board";
import type { BoardRepository } from "./board-repository";

const SLUG = "board-slug-00000000001";

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    slug: SLUG,
    title: "Kitchen finds",
    counters: emptyBoardCounters(),
    createdAt: 1_000,
    version: 0,
    ...overrides,
  };
}

function makeParticipant(overrides: Partial<Participant> = {}): Participant {
  return {
    id: "part-1",
    boardId: SLUG,
    displayName: "Aye",
    cookieSecretHash: "hash",
    createdAt: 1_100,
    ...overrides,
  };
}

function makeElement(overrides: Partial<Element> = {}): Element {
  return {
    id: "el-1",
    boardId: SLUG,
    ownerId: "part-1",
    label: "teal mug",
    description: "a distressed teal mug",
    maskBox: { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.6 },
    cutoutRef: "elements/el-1/cutout.png",
    flattenedRef: "elements/el-1/flat.png",
    sourcePhotoId: "photo-1",
    faceFlag: false,
    createdAt: 1_200,
    ...overrides,
  };
}

function makePin(overrides: Partial<Pin> = {}): Pin {
  return {
    id: "pin-1",
    boardId: SLUG,
    elementId: "el-1",
    pinnedBy: "part-1",
    status: "candidate",
    createdAt: 1_300,
    ...overrides,
  };
}

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: "scene-1",
    boardId: SLUG,
    createdBy: "part-1",
    elementIds: ["el-1"],
    prompt: "on a sunny picnic blanket",
    status: "ready",
    imageRef: "scenes/scene-1.png",
    promptVersion: "scene.v1",
    createdAt: 1_400,
    ...overrides,
  };
}

export function describeBoardRepositoryContract(
  name: string,
  makeRepo: () => BoardRepository,
): void {
  describe(`BoardRepository contract: ${name}`, () => {
    it("creates and reads back a board as an isolated copy", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      const read = await repo.getBoard(SLUG);
      expect(read).toEqual(makeBoard());
      read!.title = "mutated";
      read!.counters.pinCount = 99;
      expect(await repo.getBoard(SLUG)).toEqual(makeBoard());
      expect(await repo.getBoard("nope")).toBeNull();
    });

    it("rejects a duplicate board slug", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await expect(repo.createBoard(makeBoard())).rejects.toThrow(RangeError);
    });

    it("updateBoardSettings: skin + Plus, version +1 per write, counters kept (PIN-103)", async () => {
      const repo = makeRepo();
      const oldTokens = { accent: "#111111", accentInk: "#ffffff", paper: "#eeeeee", line: "#cccccc", motif: "o" };
      const newTokens = { accent: "#222222", accentInk: "#000000", paper: "#fafafa", line: "#dddddd", motif: "n" };
      await repo.createBoard(makeBoard({ themeId: "old-skin", theme: oldTokens }));
      await repo.putParticipant(makeParticipant());

      const patch = { skin: { themeId: "new-skin", theme: newTokens } };
      const skinned = await repo.updateBoardSettings(SLUG, () => patch);
      expect(skinned).toMatchObject({ themeId: "new-skin", theme: newTokens, version: 1 });
      expect(skinned?.counters.participantCount).toBe(1);
      expect(await repo.getBoard(SLUG)).toEqual(skinned);
      patch.skin.theme.accent = "#mutated";
      expect((await repo.getBoard(SLUG))?.theme?.accent).toBe("#222222");

      // A skin without tokens drops the previous palette entirely.
      const bare = await repo.updateBoardSettings(SLUG, () => ({ skin: { themeId: "bare-skin" } }));
      expect(bare?.version).toBe(2);
      expect(bare).not.toHaveProperty("theme");
      expect(await repo.getBoard(SLUG)).not.toHaveProperty("theme");

      const plus = { plan: "board" as const, source: "mock" as const, grantedAt: 2_000 };
      const granted = await repo.updateBoardSettings(SLUG, () => ({ plus }));
      expect(granted).toMatchObject({ title: "Kitchen finds", themeId: "bare-skin", plus, version: 3 });
      granted!.plus!.plan = "host";
      expect((await repo.getBoard(SLUG))?.plus).toEqual(plus);

      // Counter-only writes after a settings write still keep the version.
      await repo.putParticipant(makeParticipant({ id: "part-2", createdAt: 1_150 }));
      expect(await repo.getBoard(SLUG)).toMatchObject({
        version: 3,
        counters: { participantCount: 2 },
        plus,
      });
    });

    it("updateBoardSettings mutator: sees the stored board, null is a no-op, throw writes nothing (PIN-103)", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard({ themeId: "cork" }));
      const before = await repo.getBoard(SLUG);

      const seen: unknown[] = [];
      const same = await repo.updateBoardSettings(SLUG, (current) => {
        seen.push(current.themeId);
        current.title = "mutated copy";
        return null;
      });
      expect(seen.at(-1)).toBe("cork");
      expect(same).toEqual(before);
      expect(await repo.getBoard(SLUG)).toEqual(before);

      await expect(
        repo.updateBoardSettings(SLUG, () => {
          throw new Error("refused");
        }),
      ).rejects.toThrow("refused");
      expect(await repo.getBoard(SLUG)).toEqual(before);

      let called = false;
      const missing = await repo.updateBoardSettings("nope", () => {
        called = true;
        return { skin: { themeId: "x" } };
      });
      expect(missing).toBeNull();
      expect(called).toBe(false);
      expect(await repo.getBoard("nope")).toBeNull();
    });

    it("updateBoardSettings: concurrent read-modify-writes never lose an update (PIN-103)", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard({ themeId: "" }));
      const append = (mark: string) =>
        repo.updateBoardSettings(SLUG, (current) => ({
          skin: { themeId: `${current.themeId ?? ""}${mark}` },
        }));
      await Promise.all(["a", "b", "c", "d", "e"].map(append));
      const after = await repo.getBoard(SLUG);
      expect([...(after?.themeId ?? "")].sort().join("")).toBe("abcde");
      expect(after?.version).toBe(5);
    });

    it("upserts participants and counts each once", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await repo.putParticipant(makeParticipant());
      await repo.putParticipant(makeParticipant({ displayName: "Aye A." }));
      await repo.putParticipant(makeParticipant({ id: "part-2", createdAt: 1_150 }));
      expect((await repo.getParticipant(SLUG, "part-1"))?.displayName).toBe("Aye A.");
      expect((await repo.listParticipants(SLUG)).map((p) => p.id)).toEqual([
        "part-1",
        "part-2",
      ]);
      expect((await repo.getBoard(SLUG))?.counters.participantCount).toBe(2);
      expect(await repo.getParticipant(SLUG, "ghost")).toBeNull();
    });

    it("emits participant_joined once per new participant, never on upsert (PIN-74)", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await repo.putParticipant(makeParticipant());
      await repo.putParticipant(makeParticipant({ displayName: "Aye A." }));
      await repo.putParticipant(makeParticipant({ id: "part-2", createdAt: 1_150 }));
      const events = await repo.listEvents(SLUG);
      expect(events.map((e) => e.type)).toEqual([
        "participant_joined",
        "participant_joined",
      ]);
      expect(events[0]).toMatchObject({ actorId: "part-1", boardId: SLUG });
      expect(events[1]).toMatchObject({ actorId: "part-2", createdAt: 1_150 });
      expect(events[0].id).not.toBe("");
      expect(events[0].id).not.toBe(events[1].id);
    });

    it("reclaim attempts: atomic mutate, isolated copies, clear, per-board keys (PIN-90)", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await repo.createBoard(makeBoard({ slug: "board-b" }));
      expect(await repo.getReclaimAttempt(SLUG, "key-a")).toBeNull();

      const first = await repo.mutateReclaimAttempt(SLUG, "key-a", (current) => {
        expect(current).toBeNull();
        return {
          boardId: SLUG,
          key: "key-a",
          failures: 1,
          firstFailureAt: 2_000,
          lastFailureAt: 2_000,
          lockedUntil: 0,
        };
      });
      expect(first?.failures).toBe(1);
      first!.failures = 99;
      expect((await repo.getReclaimAttempt(SLUG, "key-a"))?.failures).toBe(1);

      const second = await repo.mutateReclaimAttempt(SLUG, "key-a", (current) => ({
        ...(current as NonNullable<typeof current>),
        failures: (current?.failures ?? 0) + 1,
        lastFailureAt: 2_100,
        lockedUntil: 3_000,
      }));
      expect(second).toMatchObject({ failures: 2, lockedUntil: 3_000 });
      // Same key on another board is a separate counter.
      expect(await repo.getReclaimAttempt("board-b", "key-a")).toBeNull();

      expect(await repo.mutateReclaimAttempt(SLUG, "key-a", () => null)).toBeNull();
      expect(await repo.getReclaimAttempt(SLUG, "key-a")).toBeNull();
      await expect(
        repo.mutateReclaimAttempt("ghost-board", "key-a", () => null),
      ).rejects.toThrow(RangeError);
      await expect(
        repo.mutateReclaimAttempt(SLUG, "key-a", () => ({
          boardId: SLUG,
          key: "other-key",
          failures: 1,
          firstFailureAt: 2_000,
          lastFailureAt: 2_000,
          lockedUntil: 0,
        })),
      ).rejects.toThrow(RangeError);
    });

    it("createParticipantIfBelowCap enforces the cap atomically (PIN-91)", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      expect(
        await repo.createParticipantIfBelowCap(makeParticipant(), 2),
      ).toBe(true);
      expect(
        await repo.createParticipantIfBelowCap(
          makeParticipant({ id: "part-2", createdAt: 1_150 }),
          2,
        ),
      ).toBe(true);

      // At cap: refused, and nothing was written — no participant,
      // no counter bump, no participant_joined event.
      expect(
        await repo.createParticipantIfBelowCap(
          makeParticipant({ id: "part-3", displayName: "Third", createdAt: 1_160 }),
          2,
        ),
      ).toBe(false);
      expect(await repo.getParticipant(SLUG, "part-3")).toBeNull();
      expect((await repo.listParticipants(SLUG)).map((p) => p.id)).toEqual([
        "part-1",
        "part-2",
      ]);
      expect((await repo.getBoard(SLUG))?.counters.participantCount).toBe(2);
      expect(
        (await repo.listEvents(SLUG)).filter((e) => e.type === "participant_joined"),
      ).toHaveLength(2);

      // An existing roster member upserts past the cap (renames,
      // cookie rotation and reclaims are never cap-blocked).
      expect(
        await repo.createParticipantIfBelowCap(
          makeParticipant({ displayName: "Aye A." }),
          2,
        ),
      ).toBe(true);
      expect((await repo.getParticipant(SLUG, "part-1"))?.displayName).toBe("Aye A.");
      expect((await repo.getBoard(SLUG))?.counters.participantCount).toBe(2);

      await expect(
        repo.createParticipantIfBelowCap(makeParticipant({ boardId: "ghost" }), 2),
      ).rejects.toThrow(RangeError);
    });

    it("concurrent cap-checked creates stop exactly at the cap (PIN-91)", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repo.createParticipantIfBelowCap(
            makeParticipant({ id: `racer-${i}`, createdAt: 2_000 + i }),
            3,
          ),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(3);
      expect(await repo.listParticipants(SLUG)).toHaveLength(3);
      expect((await repo.getBoard(SLUG))?.counters.participantCount).toBe(3);
    });

    it("tryRecordJoin: fixed-window budget, denials record nothing (PIN-91)", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await repo.createBoard(makeBoard({ slug: "board-b" }));
      const params = { maxJoins: 2, windowMs: 60_000 };

      expect(await repo.tryRecordJoin(SLUG, "key-a", 10_000, params)).toBe(true);
      expect(await repo.tryRecordJoin(SLUG, "key-a", 11_000, params)).toBe(true);
      expect(await repo.tryRecordJoin(SLUG, "key-a", 12_000, params)).toBe(false);
      // A different key, and the same key on another board, are
      // separate budgets.
      expect(await repo.tryRecordJoin(SLUG, "key-b", 12_000, params)).toBe(true);
      expect(await repo.tryRecordJoin("board-b", "key-a", 12_000, params)).toBe(true);
      // Denials did not extend the window: it still rolls 60s
      // after the first recorded join.
      expect(await repo.tryRecordJoin(SLUG, "key-a", 69_999, params)).toBe(false);
      expect(await repo.tryRecordJoin(SLUG, "key-a", 70_000, params)).toBe(true);

      await expect(
        repo.tryRecordJoin("ghost-board", "key-a", 70_000, params),
      ).rejects.toThrow(RangeError);
    });

    it("rejects writes against a missing board", async () => {
      const repo = makeRepo();
      await expect(repo.putParticipant(makeParticipant())).rejects.toThrow(RangeError);
      await expect(repo.createElement(makeElement())).rejects.toThrow(RangeError);
      await expect(repo.createPin(makePin())).rejects.toThrow(RangeError);
      await expect(repo.putScene(makeScene())).rejects.toThrow(RangeError);
      await expect(
        repo.appendEvent({
          id: "e1",
          boardId: SLUG,
          type: "scene_requested",
          actorId: "part-1",
          createdAt: 1_500,
        }),
      ).rejects.toThrow(RangeError);
    });

    it("creates elements, emits element_added, lists by board and owner", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await repo.createElement(makeElement());
      await repo.createElement(
        makeElement({ id: "el-2", ownerId: "part-2", createdAt: 1_250, faceFlag: true }),
      );
      expect((await repo.getElement("el-1"))?.ownerId).toBe("part-1");
      expect((await repo.listElements(SLUG)).map((e) => e.id)).toEqual(["el-1", "el-2"]);
      expect((await repo.listElementsByOwner(SLUG, "part-2")).map((e) => e.id)).toEqual([
        "el-2",
      ]);
      expect((await repo.getBoard(SLUG))?.counters.elementCount).toBe(2);

      const events = await repo.listEvents(SLUG);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "element_added",
        actorId: "part-1",
        elementId: "el-1",
        boardId: SLUG,
        createdAt: 1_200,
      });
      expect(events[0].id).not.toBe("");
      expect(events[0].id).not.toBe(events[1].id);
      await expect(repo.createElement(makeElement())).rejects.toThrow(RangeError);
    });

    it("listElementsBySource returns library copies across boards (PIN-85)", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await repo.createBoard(makeBoard({ slug: "board-b", createdAt: 1_100 }));
      await repo.createElement(makeElement());
      await repo.createElement(
        makeElement({
          id: "el-copy",
          boardId: "board-b",
          sourceElementId: "el-1",
          createdAt: 1_300,
        }),
      );
      await repo.createElement(makeElement({ id: "el-other", createdAt: 1_400 }));
      expect((await repo.listElementsBySource("el-1")).map((e) => e.id)).toEqual([
        "el-copy",
      ]);
      expect(await repo.listElementsBySource("el-copy")).toEqual([]);
      // Copies share the source's refs verbatim (makeElement
      // default), so both records list under the one cutoutRef.
      expect(
        (await repo.listElementsByCutoutRef("elements/el-1/cutout.png")).map(
          (e) => e.id,
        ),
      ).toEqual(["el-1", "el-copy", "el-other"]);
      expect(await repo.listElementsByCutoutRef("elements/none.png")).toEqual([]);
    });

    it("pins: candidate is silent, pinning emits pin_added once, counters track pinned", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await repo.createElement(makeElement());
      await repo.createPin(makePin());
      expect((await repo.listEvents(SLUG)).map((e) => e.type)).toEqual(["element_added"]);
      expect((await repo.getBoard(SLUG))?.counters.pinCount).toBe(0);

      const pinned = await repo.setPinStatus("pin-1", "pinned", 2_000);
      expect(pinned?.status).toBe("pinned");
      expect((await repo.getBoard(SLUG))?.counters.pinCount).toBe(1);
      const events = await repo.listEvents(SLUG);
      expect(events.map((e) => e.type)).toEqual(["element_added", "pin_added"]);
      expect(events[1]).toMatchObject({ actorId: "part-1", pinId: "pin-1", createdAt: 2_000 });

      // No-op transition: no second event, counter unchanged.
      await repo.setPinStatus("pin-1", "pinned", 2_100);
      expect(await repo.listEvents(SLUG)).toHaveLength(2);
      expect((await repo.getBoard(SLUG))?.counters.pinCount).toBe(1);

      // Back to candidate drops the counter, still no new event.
      await repo.setPinStatus("pin-1", "candidate", 2_200);
      expect((await repo.getBoard(SLUG))?.counters.pinCount).toBe(0);
      expect(await repo.listEvents(SLUG)).toHaveLength(2);
      expect(await repo.setPinStatus("ghost", "pinned", 2_300)).toBeNull();
    });

    it("a pin created already pinned emits pin_added at its createdAt", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await repo.createElement(makeElement());
      await repo.createPin(makePin({ status: "pinned", pinnedBy: "part-2" }));
      const events = await repo.listEvents(SLUG);
      expect(events.at(-1)).toMatchObject({
        type: "pin_added",
        actorId: "part-2",
        elementId: "el-1",
        createdAt: 1_300,
      });
      expect((await repo.getBoard(SLUG))?.counters.pinCount).toBe(1);
      expect((await repo.listPins(SLUG, "pinned")).map((p) => p.id)).toEqual(["pin-1"]);
      expect(await repo.listPins(SLUG, "candidate")).toEqual([]);
    });

    it("rejects pins for missing/other-board elements and duplicate board pins", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await repo.createBoard(makeBoard({ slug: "other-board" }));
      await repo.createElement(makeElement());
      await expect(repo.createPin(makePin({ elementId: "ghost" }))).rejects.toThrow(
        RangeError,
      );
      await expect(
        repo.createPin(makePin({ id: "pin-x", boardId: "other-board" })),
      ).rejects.toThrow(RangeError);
      await repo.createPin(makePin());
      await expect(repo.createPin(makePin({ id: "pin-2", pinnedBy: "part-2" }))).rejects.toThrow(
        RangeError,
      );
      // After deletePin the same element can be pinned again.
      expect(await repo.deletePin("pin-1")).toBe(true);
      expect(await repo.deletePin("pin-1")).toBe(false);
      await repo.createPin(makePin({ id: "pin-2", pinnedBy: "part-2" }));
      expect((await repo.listPinsForElement("el-1")).map((p) => p.id)).toEqual(["pin-2"]);
    });

    it("scenes: put/list/hidden filtering and sceneCount", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await repo.putScene(makeScene());
      await repo.putScene(makeScene({ id: "scene-2", createdAt: 1_450, hidden: true }));
      expect((await repo.listScenes(SLUG)).map((s) => s.id)).toEqual(["scene-1"]);
      expect(
        (await repo.listScenes(SLUG, { includeHidden: true })).map((s) => s.id),
      ).toEqual(["scene-1", "scene-2"]);
      expect((await repo.getBoard(SLUG))?.counters.sceneCount).toBe(1);
      // Unhide via upsert brings the count back.
      await repo.putScene(makeScene({ id: "scene-2", createdAt: 1_450 }));
      expect((await repo.getBoard(SLUG))?.counters.sceneCount).toBe(2);
      expect((await repo.getScene("scene-2"))?.hidden).toBeUndefined();
    });

    it("events: append-only, chronological, limit keeps the most recent", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await repo.appendEvent({
        id: "e2",
        boardId: SLUG,
        type: "scene_ready",
        actorId: "part-1",
        sceneId: "scene-1",
        createdAt: 3_000,
      });
      await repo.appendEvent({
        id: "e1",
        boardId: SLUG,
        type: "scene_requested",
        actorId: "part-1",
        sceneId: "scene-1",
        createdAt: 2_900,
      });
      await repo.appendEvent({
        id: "e3",
        boardId: SLUG,
        type: "scene_failed",
        actorId: "part-1",
        createdAt: 3_000,
      });
      // Sorted by createdAt; the 3000 tie keeps append order (e2 before e3).
      expect((await repo.listEvents(SLUG)).map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
      expect((await repo.listEvents(SLUG, { limit: 2 })).map((e) => e.id)).toEqual([
        "e2",
        "e3",
      ]);
      expect(await repo.listEvents(SLUG, { limit: 0 })).toEqual([]);
      await expect(
        repo.appendEvent({
          id: "e1",
          boardId: SLUG,
          type: "scene_requested",
          actorId: "part-1",
          createdAt: 3_100,
        }),
      ).rejects.toThrow(RangeError);
    });

    it("deleteElement cascades: pins removed, scenes hidden, counters follow", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await repo.createElement(makeElement());
      await repo.createElement(makeElement({ id: "el-2", createdAt: 1_210 }));
      await repo.createPin(makePin({ status: "pinned" }));
      await repo.createPin(makePin({ id: "pin-2", elementId: "el-2" }));
      await repo.putScene(makeScene());
      await repo.putScene(makeScene({ id: "scene-2", elementIds: ["el-2"], createdAt: 1_410 }));
      await repo.putScene(
        makeScene({ id: "scene-3", elementIds: ["el-1", "el-2"], createdAt: 1_420 }),
      );
      await repo.putScene(
        makeScene({ id: "scene-4", createdAt: 1_430, hidden: true }),
      );

      const result = await repo.deleteElement("el-1");
      expect(result.deleted).toBe(true);
      expect(result.removedPinIds).toEqual(["pin-1"]);
      // scene-4 was already hidden: not reported again, not double-counted.
      expect(result.hiddenSceneIds).toEqual(["scene-1", "scene-3"]);

      expect(await repo.getElement("el-1")).toBeNull();
      expect(await repo.getPin("pin-1")).toBeNull();
      expect(await repo.listPinsForElement("el-1")).toEqual([]);
      expect((await repo.getScene("scene-1"))?.hidden).toBe(true);
      expect((await repo.listScenes(SLUG)).map((s) => s.id)).toEqual(["scene-2"]);
      expect((await repo.getBoard(SLUG))?.counters).toEqual({
        participantCount: 0,
        elementCount: 1,
        pinCount: 0,
        sceneCount: 1,
      });
      // The other participant's element/pin/scene are untouched.
      expect((await repo.getElement("el-2"))?.label).toBe("teal mug");
      expect((await repo.getPin("pin-2"))?.elementId).toBe("el-2");

      // Idempotent: deleting again (or a ghost) is a no-op result.
      expect(await repo.deleteElement("el-1")).toEqual({
        deleted: false,
        removedPinIds: [],
        hiddenSceneIds: [],
      });
      expect((await repo.deleteElement("ghost")).deleted).toBe(false);
    });

    it("stored writes are isolated from later caller mutation", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      const element = makeElement();
      await repo.createElement(element);
      element.label = "mutated";
      element.maskBox.x1 = 9;
      const read = await repo.getElement("el-1");
      expect(read?.label).toBe("teal mug");
      expect(read?.maskBox.x1).toBe(0.1);
    });

    it("keeps boards fully separate", async () => {
      const repo = makeRepo();
      await repo.createBoard(makeBoard());
      await repo.createBoard(makeBoard({ slug: "board-b" }));
      await repo.createElement(makeElement());
      await repo.createElement(makeElement({ id: "el-b", boardId: "board-b" }));
      expect((await repo.listElements(SLUG)).map((e) => e.id)).toEqual(["el-1"]);
      expect((await repo.listElements("board-b")).map((e) => e.id)).toEqual(["el-b"]);
      expect((await repo.listEvents("board-b")).map((e) => e.elementId)).toEqual(["el-b"]);
      expect((await repo.getBoard("board-b"))?.counters.elementCount).toBe(1);
    });
  });
}
