import { describe, expect, it } from "vitest";
import { emptyBoardCounters, type Board, type Element, type Participant, type Pin, type Scene } from "./board";
import { planDemoClone, sceneFileName, type DemoCloneOptions, type DemoCloneSource } from "./demo-clone";

/**
 * The clone plan (PIN-251) is pure: given the template's records it
 * says exactly what the new board holds and which pictures to copy.
 */
const TEMPLATE = "tmplAAAAAAAAAAAAAAAAA1";
const CLONE = "cloneBBBBBBBBBBBBBBBB1";
const NOW = 5_000_000;
const EXPIRES = NOW + 86_400_000;

function template(overrides: Partial<Board> = {}): Board {
  return {
    slug: TEMPLATE,
    title: "Pinneds demo board (seeded, synthetic)",
    themeId: "cat",
    theme: { accent: "#111111", accentInk: "#ffffff", paper: "#eeeeee", line: "#cccccc", motif: "o" },
    policyOverrides: { participantsPerBoard: 500 },
    plus: { plan: "board", source: "stripe", grantedAt: 1 },
    host: { tokenHash: "template-host-hash", issuedAt: 1 },
    starterMakes: 20,
    freePhotos: 15,
    counters: { participantCount: 2, elementCount: 3, pinCount: 2, sceneCount: 1 },
    createdAt: 1_000,
    version: 7,
    ...overrides,
  };
}

function participant(id: string, overrides: Partial<Participant> = {}): Participant {
  return { id, boardId: TEMPLATE, displayName: `Name ${id}`, cookieSecretHash: `hash-${id}`, createdAt: 1_100, ...overrides };
}

function element(id: string, ownerId: string, overrides: Partial<Element> = {}): Element {
  return {
    id,
    boardId: TEMPLATE,
    ownerId,
    label: `label ${id}`,
    description: `desc ${id}`,
    maskBox: { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.6 },
    cutoutRef: `elements/boards/${TEMPLATE}/${id}/cutout.png`,
    flattenedRef: `elements/boards/${TEMPLATE}/${id}/flattened.jpg`,
    sourcePhotoId: `job-${id}`,
    faceFlag: id === "el-2",
    createdAt: 1_200,
    ...overrides,
  };
}

function pin(id: string, elementId: string, pinnedBy: string, status: Pin["status"] = "pinned"): Pin {
  return { id, boardId: TEMPLATE, elementId, pinnedBy, status, createdAt: 1_300 };
}

function scene(id: string, createdBy: string, elementIds: string[], overrides: Partial<Scene> = {}): Scene {
  return {
    id,
    boardId: TEMPLATE,
    createdBy,
    elementIds,
    prompt: `prompt ${id}`,
    status: "ready",
    imageRef: `scenes/boards/${TEMPLATE}/${id}/scene.png`,
    width: 1024,
    height: 1536,
    promptVersion: "scene.v1",
    kind: "ai",
    costUsd: 0.04,
    createdAt: 1_400,
    ...overrides,
  };
}

function source(overrides: Partial<DemoCloneSource> = {}): DemoCloneSource {
  return {
    template: template(),
    participants: [participant("p-mia", { userId: "uid-mia", reclaimPinHash: "pin-hash" }), participant("p-sam")],
    elements: [
      element("el-1", "p-mia"),
      element("el-2", "p-sam"),
      element("el-3", "p-sam"), // never pinned, in no scene: a leftover
      element("el-4", "p-mia", { sourceElementId: "root-elsewhere" }), // pinned library copy
    ],
    pins: [pin("pin-1", "el-1", "p-mia"), pin("pin-2", "el-2", "p-sam"), pin("pin-4", "el-4", "p-mia"), pin("pin-c", "el-3", "p-sam", "candidate")],
    scenes: [scene("sc-1", "p-mia", ["el-1", "el-2"])],
    ...overrides,
  };
}

function options(overrides: Partial<DemoCloneOptions> = {}): DemoCloneOptions {
  let n = 0;
  return {
    slug: CLONE,
    title: "Demo board",
    now: NOW,
    expiresAt: EXPIRES,
    host: { tokenHash: "visitor-host-hash", issuedAt: NOW },
    starterMakes: 2,
    freePhotos: 3,
    newId: () => `new-${++n}`,
    newCookieSecretHash: () => `fresh-hash-${n}`,
    ...overrides,
  };
}

describe("planDemoClone (PIN-251)", () => {
  it("builds a free demo board: template look kept, Plus/overrides/host/pool not copied, demo fields set", () => {
    const { board } = planDemoClone(source(), options());
    expect(board).toEqual({
      slug: CLONE,
      title: "Demo board",
      themeId: "cat",
      theme: template().theme,
      host: { tokenHash: "visitor-host-hash", issuedAt: NOW },
      starterMakes: 2,
      freePhotos: 3,
      demo: { templateSlug: TEMPLATE, expiresAt: EXPIRES },
      demoSweepAt: EXPIRES,
      counters: emptyBoardCounters(),
      createdAt: NOW,
      version: 1,
    });
    expect(board).not.toHaveProperty("plus");
    expect(board).not.toHaveProperty("policyOverrides");
    expect(board.host).not.toEqual(template().host);
  });

  it("clones the roster with fresh ids and hashes, never a userId or reclaim PIN", () => {
    const { participants } = planDemoClone(source(), options());
    expect(participants.map((p) => p.displayName)).toEqual(["Name p-mia", "Name p-sam"]);
    for (const p of participants) {
      expect(p.boardId).toBe(CLONE);
      expect(p.id).toMatch(/^new-/);
      expect(p.cookieSecretHash).toMatch(/^fresh-hash-/);
      expect(p.createdAt).toBe(NOW);
      expect(p).not.toHaveProperty("userId");
      expect(p).not.toHaveProperty("reclaimPinHash");
    }
    expect(new Set(participants.map((p) => p.cookieSecretHash)).size).toBe(2);
  });

  it("keeps pinned and scene elements with shared files, drops leftovers and library provenance", () => {
    const plan = planDemoClone(source(), options());
    expect(plan.elements.map((e) => e.label)).toEqual(["label el-1", "label el-2", "label el-4"]);
    const [e1, e2, e4] = plan.elements;
    expect(e1.cutoutRef).toBe(`elements/boards/${TEMPLATE}/el-1/cutout.png`);
    expect(e1.flattenedRef).toBe(`elements/boards/${TEMPLATE}/el-1/flattened.jpg`);
    expect(e2.faceFlag).toBe(true);
    expect(e4).not.toHaveProperty("sourceElementId");
    const owners = new Map(plan.participants.map((p) => [p.displayName, p.id]));
    expect(e1.ownerId).toBe(owners.get("Name p-mia"));
    expect(e2.ownerId).toBe(owners.get("Name p-sam"));
    for (const e of plan.elements) expect(e.boardId).toBe(CLONE);
  });

  it("remaps pinned pins only and skips candidates", () => {
    const plan = planDemoClone(source(), options());
    const byLabel = new Map(plan.elements.map((e) => [e.label, e.id]));
    expect(plan.pins).toHaveLength(3);
    expect(plan.pins.map((p) => p.elementId)).toEqual([byLabel.get("label el-1"), byLabel.get("label el-2"), byLabel.get("label el-4")]);
    for (const p of plan.pins) {
      expect(p.status).toBe("pinned");
      expect(p.boardId).toBe(CLONE);
      expect(plan.participants.some((x) => x.id === p.pinnedBy)).toBe(true);
    }
  });

  it("clones ready visible scenes into the new board's own folder and lists the picture copy", () => {
    const plan = planDemoClone(source(), options());
    expect(plan.scenes).toHaveLength(1);
    const [sc] = plan.scenes;
    const byLabel = new Map(plan.elements.map((e) => [e.label, e.id]));
    expect(sc.elementIds).toEqual([byLabel.get("label el-1"), byLabel.get("label el-2")]);
    expect(sc.imageRef).toBe(`scenes/boards/${CLONE}/${sc.id}/scene.png`);
    expect(sc).toMatchObject({ boardId: CLONE, status: "ready", prompt: "prompt sc-1", promptVersion: "scene.v1", kind: "ai", width: 1024, height: 1536, createdAt: NOW });
    expect(sc).not.toHaveProperty("costUsd");
    expect(plan.copies).toEqual([{ from: `scenes/boards/${TEMPLATE}/sc-1/scene.png`, to: sc.imageRef }]);
  });

  it("skips hidden, deleted, unfinished, pictureless and dangling scenes (and nothing else refers to them)", () => {
    const plan = planDemoClone(
      source({
        scenes: [
          scene("sc-ok", "p-sam", ["el-2"]),
          scene("sc-hidden", "p-mia", ["el-1"], { hidden: true }),
          scene("sc-deleted", "p-mia", ["el-1"], { hidden: true, deletedAt: 2_000, deletedBy: "maker" }),
          scene("sc-running", "p-mia", ["el-1"], { status: "running", imageRef: undefined }),
          scene("sc-noimage", "p-mia", ["el-1"], { imageRef: undefined }),
          scene("sc-dangling", "p-mia", ["el-1", "el-gone"]),
          scene("sc-foreign", "p-mia", ["el-1"], { imageRef: "scenes/boards/otherBoardXXXXXXXXXXX1/x/scene.png" }),
          scene("sc-remix", "p-sam", ["el-1"], { parentSceneId: "sc-ok" }),
          scene("sc-orphan-remix", "p-sam", ["el-1"], { parentSceneId: "sc-hidden" }),
        ],
      }),
      options(),
    );
    expect(plan.scenes.map((s) => s.prompt)).toEqual(["prompt sc-ok", "prompt sc-remix", "prompt sc-orphan-remix"]);
    const ok = plan.scenes[0];
    expect(plan.scenes[1].parentSceneId).toBe(ok.id);
    expect(plan.scenes[2]).not.toHaveProperty("parentSceneId");
    expect(plan.copies).toHaveLength(3);
    for (const copy of plan.copies) {
      expect(copy.from.startsWith(`scenes/boards/${TEMPLATE}/`)).toBe(true);
      expect(copy.to.startsWith(`scenes/boards/${CLONE}/`)).toBe(true);
    }
  });

  it("keeps a remix's parent link whatever the listing order, and drops it when the parent is not written", () => {
    const plan = planDemoClone(
      source({
        scenes: [
          // The remix comes BEFORE its parent in the listing.
          scene("sc-remix", "p-sam", ["el-1"], { parentSceneId: "sc-ok" }),
          scene("sc-ok", "p-mia", ["el-1", "el-2"]),
          // Its parent is kept by status but cannot be written (a pin the template no longer has).
          scene("sc-orphan", "p-sam", ["el-2"], { parentSceneId: "sc-dangling" }),
          scene("sc-dangling", "p-mia", ["el-1", "el-gone"]),
        ],
      }),
      options(),
    );
    expect(plan.scenes.map((s) => s.prompt)).toEqual(["prompt sc-remix", "prompt sc-ok", "prompt sc-orphan"]);
    const [remix, ok, orphan] = plan.scenes;
    expect(remix.parentSceneId).toBe(ok.id);
    expect(orphan).not.toHaveProperty("parentSceneId");
    expect(plan.copies.map((c) => c.to)).toEqual(plan.scenes.map((s) => s.imageRef));
  });

  it("keeps an unpinned element a scene still shows, and gives every record a unique fresh id", () => {
    const plan = planDemoClone(
      source({ pins: [pin("pin-2", "el-2", "p-sam")], scenes: [scene("sc-1", "p-mia", ["el-1", "el-2"])] }),
      options(),
    );
    expect(plan.elements.map((e) => e.label).sort()).toEqual(["label el-1", "label el-2"]);
    expect(plan.pins).toHaveLength(1);
    const ids = [...plan.participants, ...plan.elements, ...plan.pins, ...plan.scenes].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("new-"))).toBe(true);
  });

  it("an empty template still yields a valid empty board", () => {
    const plan = planDemoClone(source({ participants: [], elements: [], pins: [], scenes: [] }), options());
    expect(plan.board.slug).toBe(CLONE);
    expect([plan.participants, plan.elements, plan.pins, plan.scenes, plan.copies].map((l) => l.length)).toEqual([0, 0, 0, 0, 0]);
  });

  it("sceneFileName accepts only a file directly inside the scene's own folder", () => {
    expect(sceneFileName(`scenes/boards/${TEMPLATE}/sc-1/scene.png`, TEMPLATE, "sc-1")).toBe("scene.png");
    expect(sceneFileName(`scenes/boards/${TEMPLATE}/sc-1/deep/scene.png`, TEMPLATE, "sc-1")).toBeNull();
    expect(sceneFileName(`scenes/boards/${TEMPLATE}/sc-2/scene.png`, TEMPLATE, "sc-1")).toBeNull();
    expect(sceneFileName(`scenes/boards/${TEMPLATE}/sc-1/`, TEMPLATE, "sc-1")).toBeNull();
    expect(sceneFileName(`elements/boards/${TEMPLATE}/sc-1/scene.png`, TEMPLATE, "sc-1")).toBeNull();
  });
});
