import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  emptyBoardCounters,
  type Element,
  type SceneJob,
} from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { mockElementNamer, mockSegmenter } from "../gateway/mock-ports";
import type {
  ComposeSceneInput,
  PortOutcome,
  SceneComposer,
} from "../gateway/ports";
import {
  resolvePolicy,
  type Policy,
  type PolicyOverrides,
} from "../policy/policy";
import {
  deleteScene,
  getSceneView,
  getScenesView,
  publicScene,
  requestScene,
  resolveSceneImage,
  type BoardApiDeps,
} from "./board-api";
import { InMemoryDecomposeJobStore } from "./decompose-job";
import { InMemoryDerivativeStore } from "./derivative-store";
import {
  InMemorySceneJobStore,
  SceneJobRequestError,
  buildSceneImageRef,
  buildScenePreviewRef,
  runSceneJob,
  sniffSceneImage,
  startSceneJob,
  type SceneJobDeps,
} from "./scene-job";

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
// 1x1 PNG (same bytes the mock composer returns).
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";

type ComposerBehavior =
  | { kind: "ready" }
  | { kind: "refused" }
  | { kind: "cap"; errorCode: string }
  | { kind: "failed" }
  | { kind: "empty" }
  | { kind: "image"; base64: string };

interface Harness {
  deps: SceneJobDeps;
  api: BoardApiDeps;
  boards: InMemoryBoardRepository;
  jobs: InMemorySceneJobStore;
  store: InMemoryDerivativeStore;
  calls: ComposeSceneInput[];
  setBehavior(b: ComposerBehavior): void;
  setNow(now: number): void;
}

async function makeHarness(
  policyOverrides: PolicyOverrides = {},
): Promise<Harness> {
  const boards = new InMemoryBoardRepository();
  await boards.createBoard({
    slug: "board-1",
    title: "Test board",
    counters: emptyBoardCounters(),
    createdAt: 1,
    version: 1,
  });
  await boards.createBoard({
    slug: "board-2",
    title: "Other board",
    counters: emptyBoardCounters(),
    createdAt: 1,
    version: 1,
  });
  for (const [id, displayName] of [
    ["p1", "Robin"],
    ["p2", "Aye"],
  ] as const) {
    await boards.putParticipant({
      id,
      boardId: "board-1",
      displayName,
      cookieSecretHash: "hash",
      createdAt: 1,
    });
  }
  const store = new InMemoryDerivativeStore();
  // Five pinned elements (el1..el5), owners alternate Robin/Aye.
  for (let i = 1; i <= 5; i += 1) {
    const element: Element = {
      id: `el${i}`,
      boardId: "board-1",
      ownerId: i % 2 === 1 ? "p1" : "p2",
      label: `Thing ${i}`,
      description: `distinctive thing ${i}`,
      maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
      cutoutRef: `elements/boards/board-1/el${i}/cutout.png`,
      flattenedRef: `elements/boards/board-1/el${i}/flattened.jpg`,
      sourcePhotoId: "photo-1",
      faceFlag: false,
      createdAt: i,
    };
    await store.put(element.cutoutRef, Buffer.from(PNG_B64, "base64"), "image/png");
    await store.put(element.flattenedRef, Buffer.from(`flat-${i}`), "image/jpeg");
    await boards.createElement(element);
    await boards.createPin({
      id: `pin${i}`,
      boardId: "board-1",
      elementId: element.id,
      pinnedBy: element.ownerId,
      status: "pinned",
      createdAt: i,
    });
  }

  const policy: Policy = resolvePolicy(policyOverrides);
  const jobs = new InMemorySceneJobStore();
  const calls: ComposeSceneInput[] = [];
  let behavior: ComposerBehavior = { kind: "ready" };
  const composer: SceneComposer = {
    async composeScene(input) {
      calls.push(structuredClone(input));
      if (behavior.kind === "refused") {
        return {
          status: "refused",
          errorCode: "no_image",
          message: "The image model returned no image for this prompt.",
        } satisfies PortOutcome<never>;
      }
      if (behavior.kind === "cap") {
        return { status: "failed", errorCode: behavior.errorCode };
      }
      if (behavior.kind === "failed") {
        return { status: "failed", errorCode: "http_500", httpStatus: 500 };
      }
      if (behavior.kind === "empty") {
        return {
          status: "ready",
          value: { promptVersion: input.promptVersion },
        };
      }
      const imageBase64 = behavior.kind === "image" ? behavior.base64 : PNG_B64;
      return {
        status: "ready",
        value: { imageBase64, promptVersion: input.promptVersion },
      };
    },
  };

  let now = T0;
  let seq = 0;
  const deps: SceneJobDeps = {
    boards,
    jobs,
    store,
    composer,
    policy,
    now: () => now,
    newId: () => `scene-${++seq}`,
  };
  const api: BoardApiDeps = {
    boards,
    jobs: new InMemoryDecomposeJobStore(),
    store,
    namer: mockElementNamer,
    segmenter: mockSegmenter,
    sceneJobs: jobs,
    composer,
    policy,
    now: () => now,
    newId: () => `scene-${++seq}`,
  };
  return {
    deps,
    api,
    boards,
    jobs,
    store,
    calls,
    setBehavior(b) {
      behavior = b;
    },
    setNow(value) {
      now = value;
    },
  };
}

describe("startSceneJob happy path (PIN-69)", () => {
  it("composes from flattened pins, stores scenes/ image + Scene record + events", async () => {
    const h = await makeHarness();
    const job = await startSceneJob(
      {
        boardId: "board-1",
        participantId: "p1",
        elementIds: ["el1", "el2"],
        prompt: "  on a   sunny picnic blanket ",
      },
      h.deps,
    );

    expect(job.status).toBe("ready");
    expect(job.prompt).toBe("on a sunny picnic blanket");
    expect(job.promptVersion).toBe("scene.v1");
    expect(job.costUsd).toBeGreaterThan(0);
    expect(job.imageRef).toBe(buildSceneImageRef("board-1", job.id, "png"));
    const bytes = await h.store.get(job.imageRef as string);
    expect(bytes?.equals(Buffer.from(PNG_B64, "base64"))).toBe(true);

    const scene = await h.boards.getScene(job.id);
    expect(scene).toMatchObject({
      boardId: "board-1",
      createdBy: "p1",
      elementIds: ["el1", "el2"],
      prompt: "on a sunny picnic blanket",
      status: "ready",
      imageRef: job.imageRef,
      promptVersion: "scene.v1",
      costUsd: job.costUsd,
    });
    expect((await h.boards.getBoard("board-1"))?.counters.sceneCount).toBe(1);

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0];
    expect(call).toMatchObject({
      prompt: "on a sunny picnic blanket",
      size: "1024x1536",
      store: false,
      timeoutMs: 120_000,
      promptVersion: "scene.v1",
      sceneInputMode: "flattened",
      boardId: "board-1",
      participantId: "p1",
    });
    expect(call.elements.map((e) => e.from)).toEqual(["Robin", "Aye"]);
    expect(call.elements[0].imageRef.startsWith("data:image/jpeg;base64,")).toBe(true);

    const events = await h.boards.listEvents("board-1");
    const sceneEvents = events.filter((e) => e.sceneId === job.id);
    expect(sceneEvents.map((e) => e.type)).toEqual([
      "scene_requested",
      "scene_ready",
    ]);
    expect(sceneEvents.every((e) => e.actorId === "p1")).toBe(true);
  });

  it("sniffs png/jpeg/webp scene bytes", () => {
    expect(sniffSceneImage(Buffer.from(PNG_B64, "base64")).ext).toBe("png");
    expect(
      sniffSceneImage(Buffer.from([0xff, 0xd8, 0xff, 0x00])).contentType,
    ).toBe("image/jpeg");
    expect(
      sniffSceneImage(Buffer.from("RIFFxxxxWEBPvp8 ", "latin1")).ext,
    ).toBe("webp");
  });
});

describe("idempotency and claim-before-call", () => {
  it("re-POSTing the same sceneId returns the job with no second composer call", async () => {
    const h = await makeHarness();
    const input = {
      boardId: "board-1",
      participantId: "p1",
      elementIds: ["el1"],
      prompt: "in a tiny museum",
      sceneId: "client-scene-1",
    };
    const first = await startSceneJob(input, h.deps);
    expect(first.status).toBe("ready");
    const again = await startSceneJob(input, h.deps);
    expect(again.id).toBe("client-scene-1");
    expect(again.status).toBe("ready");
    expect(h.calls).toHaveLength(1);
    expect(await h.boards.listScenes("board-1")).toHaveLength(1);

    const rerun = await runSceneJob("board-1", "client-scene-1", h.deps);
    expect(rerun.status).toBe("ready");
    expect(h.calls).toHaveLength(1);
  });

  it("the same sceneId with a different prompt/elements is a conflict, no call", async () => {
    const h = await makeHarness();
    await startSceneJob(
      {
        boardId: "board-1",
        participantId: "p1",
        elementIds: ["el1"],
        prompt: "in a tiny museum",
        sceneId: "client-scene-1",
      },
      h.deps,
    );
    const error = await startSceneJob(
      {
        boardId: "board-1",
        participantId: "p1",
        elementIds: ["el2"],
        prompt: "floating in space",
        sceneId: "client-scene-1",
      },
      h.deps,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SceneJobRequestError);
    expect(error).toMatchObject({ code: "scene_id_conflict" });
    expect(h.calls).toHaveLength(1);
    // Scene ids are global: reusing board-1's id against a Scene
    // that exists on another board conflicts too (no orphan job).
    await h.boards.putScene({
      id: "elsewhere-scene",
      boardId: "board-2",
      createdBy: "someone",
      elementIds: ["el-x"],
      prompt: "elsewhere",
      status: "ready",
      promptVersion: "scene.v1",
      createdAt: T0,
    });
    const crossBoard = await startSceneJob(
      {
        boardId: "board-1",
        participantId: "p1",
        elementIds: ["el1"],
        prompt: "in a tiny museum",
        sceneId: "elsewhere-scene",
      },
      h.deps,
    ).catch((e: unknown) => e);
    expect(crossBoard).toMatchObject({ code: "scene_id_conflict" });
    expect(await h.jobs.get("board-1", "elsewhere-scene")).toBeNull();
    expect(h.calls).toHaveLength(1);
  });

  it("two concurrent runs: only the claim winner calls the composer", async () => {
    const h = await makeHarness();
    const pending: SceneJob = {
      id: "scene-x",
      boardId: "board-1",
      participantId: "p1",
      elementIds: ["el1"],
      prompt: "at a birthday party",
      status: "pending",
      promptVersion: "scene.v1",
      createdAt: T0,
      updatedAt: T0,
    };
    await h.jobs.create(pending);
    const [a, b] = await Promise.all([
      runSceneJob("board-1", "scene-x", h.deps),
      runSceneJob("board-1", "scene-x", h.deps),
    ]);
    expect([a.status, b.status].sort()).toEqual(["ready", "running"]);
    expect(h.calls).toHaveLength(1);
    expect((await h.jobs.get("board-1", "scene-x"))?.status).toBe("ready");
  });

  it("throws RangeError for a missing job", async () => {
    const h = await makeHarness();
    await expect(runSceneJob("board-1", "missing", h.deps)).rejects.toThrow(
      RangeError,
    );
  });
});

describe("Policy caps deny before any spend", () => {
  it("pinsPerScene (Policy 1/4) rejects 5 pins and an over-long prompt", async () => {
    const h = await makeHarness({ scenePromptMaxChars: 10 });
    const tooMany = await startSceneJob(
      {
        boardId: "board-1",
        participantId: "p1",
        elementIds: ["el1", "el2", "el3", "el4", "el5"],
        prompt: "short",
      },
      h.deps,
    ).catch((e: unknown) => e);
    expect(tooMany).toMatchObject({ code: "pins_per_scene" });
    const tooLong = await startSceneJob(
      {
        boardId: "board-1",
        participantId: "p1",
        elementIds: ["el1"],
        prompt: "this prompt is far too long",
      },
      h.deps,
    ).catch((e: unknown) => e);
    expect(tooLong).toMatchObject({ code: "bad_prompt" });
    expect(h.calls).toHaveLength(0);
    expect(await h.jobs.listForBoard("board-1")).toHaveLength(0);
    expect(await h.boards.listScenes("board-1")).toHaveLength(0);
  });

  it("scenesPerParticipantPerDay denies the second scene; next day frees it", async () => {
    const h = await makeHarness({ scenesPerParticipantPerDay: 1 });
    await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "one" },
      h.deps,
    );
    const denied = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "two" },
      h.deps,
    ).catch((e: unknown) => e);
    expect(denied).toMatchObject({ code: "scenes_per_participant_day" });
    expect(h.calls).toHaveLength(1);
    // The other participant is not blocked by p1's cap.
    const other = await startSceneJob(
      { boardId: "board-1", participantId: "p2", elementIds: ["el2"], prompt: "mine" },
      h.deps,
    );
    expect(other.status).toBe("ready");
    h.setNow(T0 + DAY);
    const nextDay = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "two" },
      h.deps,
    );
    expect(nextDay.status).toBe("ready");
  });

  it("scenesPerBoardPerDay denies everyone once the board is at cap", async () => {
    const h = await makeHarness({ scenesPerBoardPerDay: 1 });
    await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "one" },
      h.deps,
    );
    const denied = await startSceneJob(
      { boardId: "board-1", participantId: "p2", elementIds: ["el2"], prompt: "two" },
      h.deps,
    ).catch((e: unknown) => e);
    expect(denied).toMatchObject({ code: "scenes_per_board_day" });
    expect(h.calls).toHaveLength(1);
    expect(await h.jobs.listForBoard("board-1")).toHaveLength(1);
  });

  it("requestScene maps cap denies to 429 and id conflicts to 409", async () => {
    const h = await makeHarness({ scenesPerParticipantPerDay: 1 });
    const p1 = await h.boards.getParticipant("board-1", "p1");
    const first = await requestScene(
      "board-1",
      p1!,
      { elementIds: ["el1"], prompt: "one", sceneId: "api-scene-1" },
      h.api,
    );
    expect(first.scene.status).toBe("ready");
    expect(publicScene("board-1", first.scene).imageUrl).toBe(
      "/api/boards/board-1/scenes/api-scene-1/image",
    );
    const capped = await requestScene(
      "board-1",
      p1!,
      { elementIds: ["el1"], prompt: "two" },
      h.api,
    ).catch((e: unknown) => e);
    expect(capped).toMatchObject({
      name: "BoardApiError",
      status: 429,
      code: "scenes_per_participant_day",
    });
    const conflict = await requestScene(
      "board-1",
      p1!,
      { elementIds: ["el2"], prompt: "changed", sceneId: "api-scene-1" },
      h.api,
    ).catch((e: unknown) => e);
    expect(conflict).toMatchObject({ status: 409, code: "scene_id_conflict" });
  });
});

describe("refused and failed paths are friendly terminal states", () => {
  it("a composer refusal becomes scene refused with the friendly line, never a throw", async () => {
    const h = await makeHarness();
    h.setBehavior({ kind: "refused" });
    const job = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "nope" },
      h.deps,
    );
    expect(job.status).toBe("refused");
    expect(job.errorCode).toBe("no_image");
    expect(job.refusalReason).toContain("couldn't make that one");
    expect(job.imageRef).toBeUndefined();
    const scene = await h.boards.getScene(job.id);
    expect(scene?.status).toBe("refused");
    expect(scene?.refusalReason).toBe(job.refusalReason);
    expect(publicScene("board-1", scene as never).imageUrl).toBeNull();
    expect(await h.store.get(buildSceneImageRef("board-1", job.id, "png"))).toBeNull();
    const types = (await h.boards.listEvents("board-1"))
      .filter((e) => e.sceneId === job.id)
      .map((e) => e.type);
    expect(types).toEqual(["scene_requested", "scene_refused"]);
    // Re-running a refused job does not call again.
    const again = await runSceneJob("board-1", job.id, h.deps);
    expect(again.status).toBe("refused");
    expect(h.calls).toHaveLength(1);
  });

  it("decorator cap/budget failures and ready-without-bytes land as failed + scene_failed", async () => {
    const h = await makeHarness();
    h.setBehavior({ kind: "cap", errorCode: "participant_cap" });
    const capped = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "x" },
      h.deps,
    );
    expect(capped).toMatchObject({ status: "failed", errorCode: "participant_cap" });
    expect((await h.boards.getScene(capped.id))?.status).toBe("failed");

    h.setBehavior({ kind: "empty" });
    const empty = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "y" },
      h.deps,
    );
    expect(empty).toMatchObject({ status: "failed", errorCode: "scene_no_image" });
    const types = (await h.boards.listEvents("board-1"))
      .filter((e) => e.type === "scene_failed")
      .map((e) => e.sceneId);
    expect(types).toEqual([capped.id, empty.id]);
  });
});

describe("deleted-element exclusion and hidden scenes", () => {
  it("a deleted (or unpinned/missing) element can never enter a scene", async () => {
    const h = await makeHarness();
    await h.boards.deleteElement("el3");
    for (const elementIds of [["el3"], ["missing"], ["el1", "el3"]]) {
      const error = await startSceneJob(
        { boardId: "board-1", participantId: "p1", elementIds, prompt: "x" },
        h.deps,
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "element_not_found" });
    }
    expect(h.calls).toHaveLength(0);
    expect(await h.jobs.listForBoard("board-1")).toHaveLength(0);
  });

  it("deleting an element between create and run fails typed with no composer call", async () => {
    const h = await makeHarness();
    const pending: SceneJob = {
      id: "scene-del",
      boardId: "board-1",
      participantId: "p1",
      elementIds: ["el4"],
      prompt: "later",
      status: "pending",
      promptVersion: "scene.v1",
      createdAt: T0,
      updatedAt: T0,
    };
    await h.jobs.create(pending);
    await h.boards.deleteElement("el4");
    const job = await runSceneJob("board-1", "scene-del", h.deps);
    expect(job).toMatchObject({ status: "failed", errorCode: "element_missing" });
    expect(h.calls).toHaveLength(0);
  });

  it("hides ready scenes everywhere once a used element is deleted", async () => {
    const h = await makeHarness();
    const p1 = await h.boards.getParticipant("board-1", "p1");
    const { scene } = await requestScene(
      "board-1",
      p1!,
      { elementIds: ["el1", "el2"], prompt: "picnic" },
      h.api,
    );
    expect((await getScenesView("board-1", h.api))?.scenes).toHaveLength(1);
    expect(await getSceneView("board-1", scene.id, h.api)).not.toBeNull();
    const image = await resolveSceneImage("board-1", scene.id, h.api);
    expect(image?.contentType).toBe("image/png");
    expect(image?.bytes.length).toBeGreaterThan(0);
    // Uniform misses before the delete.
    expect(await resolveSceneImage("board-2", scene.id, h.api)).toBeNull();
    expect(await resolveSceneImage("board-1", "missing", h.api)).toBeNull();
    expect(await getSceneView("board-2", scene.id, h.api)).toBeNull();

    const result = await h.boards.deleteElement("el1");
    expect(result.hiddenSceneIds).toEqual([scene.id]);
    expect((await getScenesView("board-1", h.api))?.scenes).toHaveLength(0);
    expect(await h.boards.listScenes("board-1")).toHaveLength(0);
    expect(await getSceneView("board-1", scene.id, h.api)).toBeNull();
    expect(await resolveSceneImage("board-1", scene.id, h.api)).toBeNull();
    expect((await h.boards.getBoard("board-1"))?.counters.sceneCount).toBe(0);
    // The record still exists for audit, flagged hidden.
    expect((await h.boards.getScene(scene.id))?.hidden).toBe(true);
  });

  it("a delete landing mid-finish cannot unhide the scene (sync race)", async () => {
    const h = await makeHarness();
    // Simulate the cascade landing between syncScene's hidden
    // read and its write: when the finish sync reads the running
    // scene, delete el1 before the write happens.
    const boards = h.boards;
    const origGetScene = boards.getScene.bind(boards);
    let armed = true;
    boards.getScene = async (sceneId: string) => {
      const scene = await origGetScene(sceneId);
      if (armed && scene?.status === "running") {
        armed = false;
        await boards.deleteElement("el1");
      }
      return scene;
    };
    const job = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "race" },
      h.deps,
    );
    expect(job.status).toBe("ready");
    expect(armed).toBe(false); // the race was actually injected
    expect((await origGetScene(job.id))?.hidden).toBe(true);
    expect(await h.boards.listScenes("board-1")).toHaveLength(0);
    expect(await getSceneView("board-1", job.id, h.api)).toBeNull();
    expect(await resolveSceneImage("board-1", job.id, h.api)).toBeNull();
  });

  it("never serves a scene whose imageRef points outside scenes/", async () => {
    const h = await makeHarness();
    await h.store.put("tmp/boards/secret/working.webp", Buffer.from("s"), "image/webp");
    await h.boards.putScene({
      id: "forged",
      boardId: "board-1",
      createdBy: "p1",
      elementIds: ["el1"],
      prompt: "x",
      status: "ready",
      imageRef: "tmp/boards/secret/working.webp",
      promptVersion: "scene.v1",
      createdAt: T0,
    });
    expect(await resolveSceneImage("board-1", "forged", h.api)).toBeNull();
    // Pre-PIN-71 records carry no kind: the API reports them "ai".
    expect(publicScene("board-1", (await h.boards.getScene("forged"))!).kind).toBe("ai");
  });
});

describe("remix (PIN-79, docs/11 section 5.7)", () => {
  async function readyParent(h: Harness) {
    const parent = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1", "el2"], prompt: "picnic" },
      h.deps,
    );
    expect(parent.status).toBe("ready");
    return parent;
  }

  it("composes parent-first with store=false, links the child, leaves the parent untouched", async () => {
    const h = await makeHarness();
    const parent = await readyParent(h);
    const parentBefore = await h.boards.getScene(parent.id);

    const child = await startSceneJob(
      {
        boardId: "board-1",
        participantId: "p2",
        elementIds: ["el3"],
        prompt: "now with confetti",
        parentSceneId: parent.id,
      },
      h.deps,
    );
    expect(child.status).toBe("ready");
    expect(child.parentSceneId).toBe(parent.id);
    expect(child.elementIds).toEqual(["el3"]); // NEW pins only
    expect(child.promptVersion).toBe("scene.v1");

    const scene = await h.boards.getScene(child.id);
    // Scene carries the credit union (new first, then parent's) so
    // credits + the delete cascade see every contributor.
    expect(scene).toMatchObject({ parentSceneId: parent.id, elementIds: ["el3", "el1", "el2"], status: "ready" });
    expect(child.creditElementIds).toEqual(["el3", "el1", "el2"]);
    expect(publicScene("board-1", scene!)).toMatchObject({ parentSceneId: parent.id });

    expect(h.calls).toHaveLength(2);
    const remixCall = h.calls[1];
    expect(remixCall.store).toBe(false);
    expect(remixCall.parentSceneImageRef).toBe(
      `data:image/png;base64,${Buffer.from(PNG_B64, "base64").toString("base64")}`,
    );
    expect(remixCall.elements).toHaveLength(1);
    expect(remixCall.elements[0].label).toBe("Thing 3");

    // Parent record + image bytes unchanged by the remix.
    expect(await h.boards.getScene(parent.id)).toEqual(parentBefore);
    const parentBytes = await h.store.get(parent.imageRef as string);
    expect(parentBytes?.equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
  });

  it("caps count NEW pins only: parent excluded, max new pins pass, max+1 denied pre-spend", async () => {
    const h = await makeHarness({ pinsPerScene: { min: 1, max: 2 } });
    const parent = await readyParent(h); // parent itself used 2 pins
    const ok = await startSceneJob(
      {
        boardId: "board-1",
        participantId: "p1",
        elementIds: ["el3", "el4"], // 2 new + parent's 2: only new count
        prompt: "more friends",
        parentSceneId: parent.id,
      },
      h.deps,
    );
    expect(ok.status).toBe("ready");
    await expect(
      startSceneJob(
        {
          boardId: "board-1",
          participantId: "p1",
          elementIds: ["el3", "el4", "el5"],
          prompt: "too many",
          parentSceneId: parent.id,
        },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: "pins_per_scene" });
    expect(h.calls).toHaveLength(2); // parent + ok remix; the deny never composed
  });

  it("denies missing, not-ready, hidden and other-board parents as parent_not_found with zero spend", async () => {
    const h = await makeHarness();
    const base = { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "x" };
    await expect(startSceneJob({ ...base, parentSceneId: "nope" }, h.deps)).rejects.toMatchObject({
      code: "parent_not_found",
    });
    await h.boards.putScene({
      id: "pending-scene",
      boardId: "board-1",
      createdBy: "p1",
      elementIds: ["el1"],
      prompt: "x",
      status: "running",
      promptVersion: "scene.v1",
      createdAt: 1,
    });
    await expect(
      startSceneJob({ ...base, parentSceneId: "pending-scene" }, h.deps),
    ).rejects.toMatchObject({ code: "parent_not_found" });
    await h.boards.putScene({
      id: "hidden-scene",
      boardId: "board-1",
      createdBy: "p1",
      elementIds: ["el1"],
      prompt: "x",
      status: "ready",
      imageRef: "scenes/boards/board-1/hidden-scene/scene.png",
      hidden: true,
      promptVersion: "scene.v1",
      createdAt: 1,
    });
    await expect(
      startSceneJob({ ...base, parentSceneId: "hidden-scene" }, h.deps),
    ).rejects.toMatchObject({ code: "parent_not_found" });
    await h.boards.putScene({
      id: "other-board-scene",
      boardId: "board-2",
      createdBy: "p1",
      elementIds: ["el1"],
      prompt: "x",
      status: "ready",
      imageRef: "scenes/boards/board-2/other-board-scene/scene.png",
      promptVersion: "scene.v1",
      createdAt: 1,
    });
    await expect(
      startSceneJob({ ...base, parentSceneId: "other-board-scene" }, h.deps),
    ).rejects.toMatchObject({ code: "parent_not_found" });
    expect(h.calls).toHaveLength(0);
  });

  it("collage fallback composites over the parent and stays labelled collage", async () => {
    // Real decodable PNGs: the harness 1x1 mock bytes are not
    // sharp-readable, and the collage actually decodes its inputs.
    const h = await makeHarness();
    const parent = await readyParent(h);
    const swatch = await sharp({ create: { width: 30, height: 20, channels: 4, background: { r: 30, g: 120, b: 200, alpha: 1 } } }).png().toBuffer();
    await h.store.put(parent.imageRef as string, swatch, "image/png");
    const el3 = await h.boards.getElement("el3");
    await h.store.put(el3!.cutoutRef, swatch, "image/png");
    const child = await startSceneJob(
      {
        boardId: "board-1",
        participantId: "p1",
        elementIds: ["el3"],
        prompt: "offline remix",
        parentSceneId: parent.id,
      },
      { ...h.deps, collageMode: true },
    );
    expect(child).toMatchObject({ status: "ready", kind: "collage", parentSceneId: parent.id, costUsd: 0 });
    expect(h.calls).toHaveLength(1); // parent only; the remix never hit the port
    const bytes = await h.store.get(child.imageRef as string);
    const meta = await sharp(bytes as Buffer).metadata();
    expect(meta.format).toBe("png");
  });

  it("parent image gone at run time fails typed before any composer spend", async () => {
    const h = await makeHarness();
    const parent = await readyParent(h);
    await h.store.delete(parent.imageRef as string);
    const child = await startSceneJob(
      {
        boardId: "board-1",
        participantId: "p1",
        elementIds: ["el3"],
        prompt: "ghost parent",
        parentSceneId: parent.id,
      },
      h.deps,
    );
    expect(child).toMatchObject({ status: "failed", errorCode: "parent_missing" });
    expect(h.calls).toHaveLength(1);
  });

  it("a parent deleted after the request is never read, even with its image left in storage (PIN-142)", async () => {
    const h = await makeHarness();
    const parent = await readyParent(h);
    const stored = await h.boards.getScene(parent.id);
    // Tombstone only: the storage delete "failed", so the bytes are still there.
    await h.boards.putScene({ ...stored!, hidden: true, deletedAt: T0, deletedBy: "host" });
    for (const [id, collageMode] of [["late-ai", false], ["late-collage", true]] as const) {
      await h.jobs.create({
        id, boardId: "board-1", participantId: "p1", elementIds: ["el3"], prompt: "late",
        status: "pending", parentSceneId: parent.id, promptVersion: "scene.v1", createdAt: T0, updatedAt: T0,
      });
      const child = await runSceneJob("board-1", id, { ...h.deps, collageMode });
      expect(child).toMatchObject({ status: "failed", errorCode: "parent_missing" });
    }
    expect(h.calls).toHaveLength(1); // the parent's own compose only
  });

  it("delete cascade hides a remix child when a PARENT contributor deletes their element", async () => {
    const h = await makeHarness();
    const parent = await readyParent(h); // el1 (p1) + el2 (p2)
    const child = await startSceneJob(
      {
        boardId: "board-1",
        participantId: "p1",
        elementIds: ["el3"],
        prompt: "remix",
        parentSceneId: parent.id,
      },
      h.deps,
    );
    expect(child.status).toBe("ready");
    // p2 deletes el2 — used only via the parent, never a child pin.
    const result = await h.boards.deleteElement("el2");
    expect(result.hiddenSceneIds).toContain(parent.id);
    expect(result.hiddenSceneIds).toContain(child.id);
    expect((await h.boards.getScene(child.id))?.hidden).toBe(true);
    const visible = await h.boards.listScenes("board-1");
    expect(visible.map((s) => s.id)).not.toContain(child.id);
  });

  it("requestScene parses parentSceneId and maps a bad parent to a 404 BoardApiError", async () => {
    const h = await makeHarness();
    const participant = await h.boards.getParticipant("board-1", "p1");
    await expect(
      requestScene(
        "board-1",
        participant!,
        { elementIds: ["el1"], prompt: "x", parentSceneId: "nope" },
        h.api,
      ),
    ).rejects.toMatchObject({ status: 404, code: "parent_not_found" });
    const parent = await readyParent(h);
    const { job, scene } = await requestScene(
      "board-1",
      participant!,
      { elementIds: ["el3"], prompt: "api remix", parentSceneId: parent.id },
      h.api,
    );
    expect(job).toMatchObject({ status: "ready", parentSceneId: parent.id });
    expect(scene).toMatchObject({ parentSceneId: parent.id });
  });
});

describe("mock collage fallback (PIN-71)", () => {
  // The harness cut-out bytes are the mock composer's header-only
  // 1x1 PNG, which sharp cannot decode; real cut-outs are
  // sharp-produced. Seed decodable cut-outs for the collage path.
  async function seedCutouts(h: Harness): Promise<void> {
    const png = await sharp({
      create: { width: 30, height: 20, channels: 4, background: { r: 20, g: 160, b: 200, alpha: 1 } },
    })
      .png()
      .toBuffer();
    for (let i = 1; i <= 5; i += 1) {
      const el = await h.boards.getElement(`el${i}`);
      await h.store.put(el!.cutoutRef, png, "image/png");
    }
  }

  it("collageMode (AI_MOCK) composes the cut-outs with NO composer call, kind collage at $0", async () => {
    const h = await makeHarness();
    await seedCutouts(h);
    const job = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1", "el2", "el3"], prompt: "in a tiny museum" },
      { ...h.deps, collageMode: true },
    );
    expect(job).toMatchObject({ status: "ready", kind: "collage", costUsd: 0 });
    expect(h.calls).toHaveLength(0); // offline: no port call, no reserve
    expect(job.imageRef).toBe(buildSceneImageRef("board-1", job.id, "png"));
    const bytes = await h.store.get(job.imageRef as string);
    expect(bytes).not.toBeNull();
    // A real collage at Policy.sceneSize, not the mock's 1x1 PNG.
    const meta = await sharp(bytes as Buffer).metadata();
    expect(meta).toMatchObject({ format: "png", width: 1024, height: 1536 });
    const scene = await h.boards.getScene(job.id);
    expect(scene).toMatchObject({ status: "ready", kind: "collage", costUsd: 0 });
    expect(publicScene("board-1", scene!).kind).toBe("collage");
    const types = (await h.boards.listEvents("board-1"))
      .filter((e) => e.sceneId === job.id)
      .map((e) => e.type);
    expect(types).toEqual(["scene_requested", "scene_ready"]);
  });

  it("an over-budget composer outcome falls back to the collage (labelled, $0)", async () => {
    const h = await makeHarness();
    await seedCutouts(h);
    h.setBehavior({ kind: "cap", errorCode: "budget" });
    const job = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1", "el2"], prompt: "picnic" },
      h.deps,
    );
    expect(h.calls).toHaveLength(1); // the (denied) port attempt happened
    expect(job).toMatchObject({ status: "ready", kind: "collage", costUsd: 0 });
    expect((await h.boards.getScene(job.id))?.kind).toBe("collage");
    expect(await h.store.get(job.imageRef as string)).not.toBeNull();
  });

  it("records the collage's pixel size on the job, the Scene and the board payload (PIN-129)", async () => {
    const h = await makeHarness({ sceneSize: "600x900" });
    await seedCutouts(h);
    const job = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "museum" },
      { ...h.deps, collageMode: true },
    );
    expect(job).toMatchObject({ status: "ready", kind: "collage", width: 600, height: 900 });
    const scene = await h.boards.getScene(job.id);
    expect(scene).toMatchObject({ width: 600, height: 900 });
    expect(publicScene("board-1", scene!)).toMatchObject({ width: 600, height: 900 });
  });

  it("an AI ready scene is recorded kind ai (collage is never disguised, and vice versa)", async () => {
    const h = await makeHarness();
    const job = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "museum" },
      h.deps,
    );
    expect(job).toMatchObject({ status: "ready", kind: "ai" });
    expect(job.costUsd).toBeGreaterThan(0);
    expect((await h.boards.getScene(job.id))?.kind).toBe("ai");
  });

  it("collageMode still excludes deleted elements and reports missing cut-outs as failed", async () => {
    const h = await makeHarness();
    await h.boards.deleteElement("el3");
    const denied = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el3"], prompt: "x" },
      { ...h.deps, collageMode: true },
    ).catch((e: unknown) => e);
    expect(denied).toMatchObject({ code: "element_not_found" });

    // Cut-out bytes gone from the store: typed failed, never a fake image.
    const missing = await makeHarness();
    const el1 = await missing.boards.getElement("el1");
    await missing.store.delete(el1!.cutoutRef);
    const job = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "x" },
      { ...missing.deps, collageMode: true },
    );
    expect(job).toMatchObject({ status: "failed", errorCode: "element_image_missing" });
    expect(job.imageRef).toBeUndefined();
  });
});

describe("scene image size (PIN-129)", () => {
  it("the model path records the stored image's real pixel size, not the Policy hint", async () => {
    const h = await makeHarness();
    // A real-sized model image (the mock's 1x1 PNG would prove nothing).
    const tall = await sharp({
      create: { width: 1280, height: 1920, channels: 3, background: { r: 200, g: 120, b: 90 } },
    })
      .png()
      .toBuffer();
    h.setBehavior({ kind: "image", base64: tall.toString("base64") });
    const job = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "picnic" },
      h.deps,
    );
    expect(job).toMatchObject({ status: "ready", kind: "ai", width: 1280, height: 1920 });
    // sceneFromJob copies the size, so every syncScene keeps it.
    const scene = await h.boards.getScene(job.id);
    expect(scene).toMatchObject({ width: 1280, height: 1920 });
    expect(publicScene("board-1", scene!)).toMatchObject({ width: 1280, height: 1920 });
    expect((await getSceneView("board-1", job.id, h.api))?.scene).toMatchObject({ width: 1280, height: 1920 });
  });

  it("unreadable image bytes still land ready, with no size (the Policy shape applies)", async () => {
    const h = await makeHarness();
    h.setBehavior({ kind: "image", base64: Buffer.from("not an image").toString("base64") });
    const job = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "picnic" },
      h.deps,
    );
    expect(job.status).toBe("ready");
    expect(job).not.toHaveProperty("width");
    const scene = await h.boards.getScene(job.id);
    expect(scene).not.toHaveProperty("width");
    const view = publicScene("board-1", scene!);
    expect(view).not.toHaveProperty("width");
    expect(view).not.toHaveProperty("height");
  });
});

describe("scene delete (PIN-142)", () => {
  const noHost = { hostToken: null };

  it("a job sync landing after the delete cannot undo the tombstone (sync race)", async () => {
    const h = await makeHarness();
    const p1 = await h.boards.getParticipant("board-1", "p1");
    // In finish's post-write element re-check: delete the scene, then el2,
    // so the re-check re-hides with a full, tombstone-less write.
    const boards = h.boards;
    const origGetElement = boards.getElement.bind(boards);
    let armed = true;
    boards.getElement = async (id: string) => {
      const ready = armed ? (await boards.listScenes("board-1")).find((s) => s.status === "ready") : undefined;
      if (ready) {
        armed = false;
        await deleteScene("board-1", ready.id, p1, noHost, h.api);
        await boards.deleteElement("el2");
      }
      return origGetElement(id);
    };
    const job = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1", "el2"], prompt: "race" },
      h.deps,
    );
    expect(job.status).toBe("ready");
    expect(armed).toBe(false); // the race was actually injected
    expect(await h.boards.getScene(job.id)).toMatchObject({ hidden: true, deletedAt: T0, deletedBy: "maker" });
    expect(await h.store.get(job.imageRef as string)).toBeNull();
    expect((await h.boards.getBoard("board-1"))?.counters.sceneCount).toBe(0);
  });

  it("a board deleted mid-compose: the runner returns quietly, nothing new shows, the request 404s (PIN-167)", async () => {
    const h = await makeHarness();
    const deleting: SceneComposer = {
      async composeScene(input) {
        await h.boards.deleteBoard("board-1", T0);
        return h.deps.composer.composeScene(input);
      },
    };
    const job = await startSceneJob(
      { boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "late" },
      { ...h.deps, composer: deleting },
    );
    expect(job.status).toBe("ready");
    expect((await h.boards.getScene(job.id))?.status).toBe("running"); // the last pre-delete sync
    expect((await h.boards.listEvents("board-1")).map((e) => e.type)).not.toContain("scene_ready");

    const fresh = await makeHarness();
    const robin = await fresh.boards.getParticipant("board-1", "p1");
    const racing: SceneComposer = {
      async composeScene(input) {
        await fresh.boards.deleteBoard("board-1", T0);
        return fresh.deps.composer.composeScene(input);
      },
    };
    await expect(
      requestScene("board-1", robin!, { elementIds: ["el1"], prompt: "late" }, { ...fresh.api, composer: racing }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("a repeat POST of a deleted scene's client id is a 404, never the dead scene", async () => {
    const h = await makeHarness();
    const p1 = await h.boards.getParticipant("board-1", "p1");
    const input = { elementIds: ["el1"], prompt: "again", sceneId: "client-1" };
    await requestScene("board-1", p1!, input, h.api);
    await deleteScene("board-1", "client-1", p1, noHost, h.api);
    await expect(requestScene("board-1", p1!, input, h.api)).rejects.toMatchObject({ status: 404 });
  });

  it("storage is best-effort and only this scene's own folder is ever deleted", async () => {
    const h = await makeHarness();
    const p1 = await h.boards.getParticipant("board-1", "p1");
    const job = await startSceneJob({ boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "x" }, h.deps);
    const forged = await startSceneJob({ boardId: "board-1", participantId: "p1", elementIds: ["el2"], prompt: "y" }, h.deps);
    // A forged ref pointing at another scene's image is never touched.
    await h.boards.putScene({ ...(await h.boards.getScene(forged.id))!, imageRef: job.imageRef });
    await deleteScene("board-1", forged.id, p1, noHost, h.api);
    expect(await h.store.get(job.imageRef as string)).not.toBeNull();
    // A failing store still leaves the tombstone; the log names no ref; a repeat retries.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(h.store, "delete").mockRejectedValueOnce(new Error(`gs://bucket/${job.imageRef}`));
    await deleteScene("board-1", job.id, p1, noHost, h.api);
    expect((await h.boards.getScene(job.id))?.deletedAt).toBe(T0);
    expect(JSON.stringify(log.mock.calls)).not.toContain("scenes/");
    vi.restoreAllMocks();
    await deleteScene("board-1", job.id, p1, noHost, h.api);
    expect(await h.store.get(job.imageRef as string)).toBeNull();
  });
});

describe("scene previews (PIN-133)", () => {
  // A real-sized 1280x1920 PNG scene, from a synthetic model output (eval/fixtures, PIN-50 spike).
  const realScene = () =>
    sharp(`${process.cwd()}/eval/fixtures/studio/scenes/C1-size-1024x1536.jpg`).resize(1280, 1920).png().toBuffer();
  const start = (h: Harness, collageMode = false) =>
    startSceneJob({ boardId: "board-1", participantId: "p1", elementIds: ["el1"], prompt: "picnic" }, { ...h.deps, collageMode });
  const preview = (h: Harness, id: string, slug = "board-1") => resolveSceneImage(slug, id, h.api, "preview");

  it("store time writes a WebP within the cap beside the full image on both paths; scene delete removes both", async () => {
    const h = await makeHarness();
    const full = await realScene();
    h.setBehavior({ kind: "image", base64: full.toString("base64") });
    const model = await start(h);
    // The collage path needs a decodable cut-out (the harness 1x1 is header-only).
    const cutout = await sharp({ create: { width: 30, height: 20, channels: 4, background: "#1ea0c8" } }).png().toBuffer();
    await h.store.put("elements/boards/board-1/el1/cutout.png", cutout, "image/png");
    const collage = await start(h, true);
    for (const job of [model, collage]) {
      expect(job.status).toBe("ready");
      const meta = await sharp((await h.store.get(buildScenePreviewRef("board-1", job.id)))!).metadata();
      expect(meta.format).toBe("webp");
      expect(Math.max(meta.width!, meta.height!)).toBe(h.deps.policy.scenePreviewMaxPx);
    }
    // The full image is stored as returned; the preview is a small fraction of it.
    const small = (await h.store.get(buildScenePreviewRef("board-1", model.id)))!;
    expect(small.length * 10).toBeLessThan(full.length);
    expect(await preview(h, model.id)).toEqual({ bytes: small, contentType: "image/webp" });
    const served = await resolveSceneImage("board-1", model.id, h.api);
    expect(served?.contentType).toBe("image/png");
    expect(served?.bytes.equals(full)).toBe(true); // toEqual walks 5 MB byte by byte
    const p1 = await h.boards.getParticipant("board-1", "p1");
    await deleteScene("board-1", model.id, p1, { hostToken: null }, h.api);
    expect(await h.store.get(model.imageRef!)).toBeNull();
    expect(await h.store.get(buildScenePreviewRef("board-1", model.id))).toBeNull();
  });

  it("an older scene's preview is made on first request, stored once, then reused", async () => {
    const h = await makeHarness();
    h.setBehavior({ kind: "image", base64: (await realScene()).toString("base64") });
    const job = await start(h);
    const ref = buildScenePreviewRef("board-1", job.id);
    await h.store.delete(ref); // stored before previews existed
    const puts = vi.spyOn(h.store, "put");
    const gets = vi.spyOn(h.store, "get");
    const first = await preview(h, job.id);
    const second = await preview(h, job.id);
    expect(first?.contentType).toBe("image/webp");
    expect(second).toEqual(first);
    // One render and put; the second request reads only the stored preview.
    expect(puts.mock.calls.map(([putRef]) => putRef)).toEqual([ref]);
    expect(gets.mock.calls.filter(([getRef]) => getRef === job.imageRef)).toHaveLength(1);
    // Two concurrent first requests render the same bytes: a harmless overwrite.
    await h.store.delete(ref);
    const [a, b] = await Promise.all([preview(h, job.id), preview(h, job.id)]);
    expect(a).toEqual(first);
    expect(b).toEqual(first);
    expect(await h.store.get(ref)).toEqual(first?.bytes);
    vi.restoreAllMocks();
  });

  it("a preview that cannot be made never fails the scene and serves the full image with its own type", async () => {
    const h = await makeHarness(); // the mock's header-only PNG: sharp cannot decode it
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const job = await start(h);
    expect(job.status).toBe("ready");
    expect(await preview(h, job.id)).toEqual({ bytes: Buffer.from(PNG_B64, "base64"), contentType: "image/png" });
    expect(await h.store.get(buildScenePreviewRef("board-1", job.id))).toBeNull();
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("scenes/");
    vi.restoreAllMocks();
  });

  it("keeps the uniform misses and never makes a preview for a hidden or deleted scene", async () => {
    const h = await makeHarness();
    h.setBehavior({ kind: "image", base64: (await realScene()).toString("base64") });
    const [ok, hidden, deleted] = [await start(h), await start(h), await start(h)];
    for (const job of [ok, hidden, deleted]) await h.store.delete(buildScenePreviewRef("board-1", job.id));
    // Full images left in storage, as after a failed best-effort delete.
    await h.boards.putScene({ ...(await h.boards.getScene(hidden.id))!, hidden: true });
    await h.boards.putScene({ ...(await h.boards.getScene(deleted.id))!, hidden: true, deletedAt: T0, deletedBy: "maker" });
    expect(await preview(h, hidden.id)).toBeNull();
    expect(await preview(h, deleted.id)).toBeNull();
    expect(await preview(h, ok.id, "board-2")).toBeNull();
    expect(await preview(h, "missing")).toBeNull();
    for (const job of [ok, hidden, deleted]) expect(await h.store.get(buildScenePreviewRef("board-1", job.id))).toBeNull();
  });
});
