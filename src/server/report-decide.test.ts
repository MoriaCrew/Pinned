import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyBoardCounters, type Element, type Participant, type Scene } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { InMemoryReportStore } from "../domain/report-store";
import { boardReportRef } from "../domain/tokens";
import { InMemoryUserRepository } from "../domain/user-repository";
import { resolvePolicy } from "../policy/policy";
import { createReport, type ReportDeps } from "./board-report";
import { InMemoryDerivativeStore } from "./derivative-store";
import { dismissReport, releaseStorageHolds, sweepDueReports, takedownReport, type ReportDecideDeps } from "./report-decide";

/**
 * The operator side (PIN-272): holds set by real reports (createReport),
 * then dismissed, taken down or swept. Memory ports, fixed clock.
 */
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const UID = "uid-mia";

const participant: Participant = { id: "p1", boardId: SLUG, displayName: "Mia", cookieSecretHash: "h", userId: UID, createdAt: 1_100 };
const refsOf = (id: string) => [`elements/boards/${SLUG}/${id}/cutout.png`, `elements/boards/${SLUG}/${id}/flattened.jpg`];
const sceneRef = (id: string) => `scenes/boards/${SLUG}/${id}/scene.webp`;

async function harness() {
  const boards = new InMemoryBoardRepository();
  const store = new InMemoryDerivativeStore();
  const reports = new InMemoryReportStore();
  const users = new InMemoryUserRepository();
  const policy = resolvePolicy(null);
  await boards.createBoard({ slug: SLUG, title: "Party", counters: emptyBoardCounters(), createdAt: 1_000, version: 0 });
  await boards.putParticipant(participant);
  await users.putUserBoard(UID, { boardId: SLUG, participantId: "p1", claimedAt: 1_100, updatedAt: 1_100 });
  const element = (id: string, faceFlag: boolean): Element => ({
    id, boardId: SLUG, ownerId: "p1", label: id, description: "", maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
    cutoutRef: refsOf(id)[0], flattenedRef: refsOf(id)[1], sourcePhotoId: "job", faceFlag, createdAt: 1_200,
  });
  await boards.createElement(element("mug", false));
  await boards.createElement(element("friend", true));
  for (const id of ["mug", "friend"]) {
    await store.put(refsOf(id)[0], Buffer.from("c"), "image/png");
    await store.put(refsOf(id)[1], Buffer.from("f"), "image/jpeg");
  }
  const scene = (id: string, elementIds: string[]): Scene => ({
    id, boardId: SLUG, createdBy: "p1", elementIds, prompt: "x", status: "ready",
    imageRef: sceneRef(id), promptVersion: "scene.v1", createdAt: 1_400,
  });
  await boards.putScene(scene("s-mug", ["mug"]));
  await boards.putScene(scene("s-both", ["mug", "friend"]));
  for (const id of ["s-mug", "s-both"]) await store.put(sceneRef(id), Buffer.from("w"), "image/webp");
  let ids = 0;
  const reportDeps: ReportDeps = { boards, store, reports, policy, now: () => NOW, newId: () => `rep-${++ids}` };
  const deps: ReportDecideDeps = { boards, users, store, reports, now: () => NOW + HOUR };
  const file = async (slug: string, body: unknown, viewer: Participant | null = null) =>
    (await createReport(slug, body, viewer, reportDeps)).record;
  return { boards, store, reports, users, deps, file };
}

describe("report decisions (PIN-272)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("dismiss puts back exactly what an element report hid, once", async () => {
    const h = await harness();
    const report = await h.file(SLUG, { scope: "element", targetId: "mug", reason: "inappropriate" });
    expect(await h.boards.listScenes(SLUG)).toEqual([]);
    const outcome = await dismissReport(report.id, h.deps, "false alarm");
    expect(outcome?.released).toEqual({ elements: 1, scenes: 0, boardReview: false, storage: false });
    expect(outcome?.record).toMatchObject({ status: "dismissed", decidedAt: NOW + HOUR, note: "false alarm" });
    expect((await h.boards.getElement("mug"))?.cutoutRef).toBe(refsOf("mug")[0]);
    expect((await h.boards.listScenes(SLUG)).map((s) => s.id)).toEqual(["s-mug", "s-both"]);
    expect(await dismissReport(report.id, h.deps)).toBeNull();
    expect(await dismissReport("missing", h.deps)).toBeNull();
  });

  it("dismiss keeps what another open report on the board still holds", async () => {
    const h = await harness();
    const first = await h.file(SLUG, { scope: "element", targetId: "mug", reason: "inappropriate" });
    const second = await h.file(SLUG, { scope: "board", reason: "illegal" });
    // Dismissing the first report: mug stays held (the board report lists it), review and storage stay.
    const one = await dismissReport(first.id, h.deps);
    expect(one?.released).toEqual({ elements: 0, scenes: 0, boardReview: false, storage: false });
    expect((await h.boards.getElement("mug"))?.cutoutRef).toBe(`held:${refsOf("mug")[0]}`);
    expect((await h.boards.getBoard(SLUG))?.reviewAt).toBe(NOW);
    expect(h.store.isHeld(refsOf("mug")[0])).toBe(true);
    // Dismissing the board report releases everything.
    const two = await dismissReport(second.id, h.deps);
    expect(two?.released).toEqual({ elements: 2, scenes: 0, boardReview: true, storage: true });
    expect((await h.boards.getBoard(SLUG))?.reviewAt).toBeUndefined();
    expect((await h.boards.listScenes(SLUG)).map((s) => s.id)).toEqual(["s-mug", "s-both"]);
    for (const ref of [...refsOf("mug"), ...refsOf("friend"), sceneRef("s-mug"), sceneRef("s-both")]) {
      expect(h.store.isHeld(ref)).toBe(false);
    }
  });

  it("dismiss of a scene report brings the scene back", async () => {
    const h = await harness();
    const report = await h.file(SLUG, { scope: "scene", targetId: "s-both", reason: "ownership" });
    const outcome = await dismissReport(report.id, h.deps);
    expect(outcome?.released).toEqual({ elements: 0, scenes: 1, boardReview: false, storage: false });
    expect((await h.boards.listScenes(SLUG)).map((s) => s.id)).toEqual(["s-mug", "s-both"]);
  });

  it("takedown of an element deletes the record and its objects, and the scenes' pictures", async () => {
    const h = await harness();
    const report = await h.file(SLUG, { scope: "element", targetId: "friend", reason: "likeness" });
    const result = await takedownReport(report.id, h.deps, "confirmed");
    expect(result).toMatchObject({ outcome: "element_deleted", record: { status: "takedown", note: "confirmed" } });
    expect(await h.boards.getElement("friend")).toBeNull();
    expect(await h.store.get(refsOf("friend")[0])).toBeNull();
    expect(await h.store.get(refsOf("friend")[1])).toBeNull();
    // s-both used friend: hidden by the hold, its picture gone with the takedown; s-mug untouched.
    expect(await h.store.get(sceneRef("s-both"))).toBeNull();
    expect(await h.store.get(sceneRef("s-mug"))).not.toBeNull();
    expect((await h.boards.getElement("mug"))?.cutoutRef).toBe(refsOf("mug")[0]);
    expect(await takedownReport(report.id, h.deps)).toBeNull();
  });

  it("takedown under an illegal-content hold keeps the held objects (evidence) and still closes the report", async () => {
    const h = await harness();
    const illegal = await h.file(SLUG, { scope: "board", reason: "illegal" });
    const result = await takedownReport(illegal.id, h.deps);
    expect(result?.outcome).toBe("board_deleted");
    expect(await h.boards.getBoard(SLUG)).toBeNull();
    for (const ref of [...refsOf("mug"), ...refsOf("friend"), sceneRef("s-mug"), sceneRef("s-both")]) {
      expect(await h.store.get(ref)).not.toBeNull();
      expect(h.store.isHeld(ref)).toBe(true);
    }
    expect(await h.users.getUserBoard(UID, SLUG)).toBeNull();
    // Close-out: release the holds, then the objects can go.
    expect(await releaseStorageHolds(SLUG, h.deps)).toEqual({ released: 6, kept: 0, failed: 0 });
    expect(h.store.isHeld(refsOf("mug")[0])).toBe(false);
  });

  it("takedown of a scene tombstones it and deletes its picture", async () => {
    const h = await harness();
    const report = await h.file(SLUG, { scope: "scene", targetId: "s-mug", reason: "inappropriate" });
    const result = await takedownReport(report.id, h.deps);
    expect(result?.outcome).toBe("scene_deleted");
    const scene = await h.boards.getScene("s-mug");
    expect(scene).toMatchObject({ hidden: true, deletedAt: NOW + HOUR, deletedBy: "host" });
    expect(await h.store.get(sceneRef("s-mug"))).toBeNull();
    expect(await h.store.get(sceneRef("s-both"))).not.toBeNull();
  });

  it("takedown of a participant's board report tombstones the board, unlinks My boards and sweeps storage", async () => {
    const h = await harness();
    const report = await h.file(SLUG, { scope: "board", reason: "inappropriate" }, participant);
    const result = await takedownReport(report.id, h.deps);
    expect(result?.outcome).toBe("board_deleted");
    expect(await h.boards.getBoard(SLUG)).toBeNull();
    expect(await h.users.getUserBoard(UID, SLUG)).toBeNull();
    for (const ref of [...refsOf("mug"), ...refsOf("friend"), sceneRef("s-mug"), sceneRef("s-both")]) {
      expect(await h.store.get(ref)).toBeNull();
    }
    // A second decision on the same report, or on a board that is gone, is not an error.
    expect(await takedownReport(report.id, h.deps)).toBeNull();
    const late = await h.reports.create({ ...report, id: "late", status: "open" }).then(() => takedownReport("late", h.deps));
    expect(late?.outcome).toBe("already_gone");
  });

  it("the sweep takes down due likeness reports in deadline order, batch-capped, and never an illegal one", async () => {
    const h = await harness();
    const timed = await h.file(SLUG, { scope: "element", targetId: "friend", reason: "likeness" });
    expect(timed.deleteAt).toBe(NOW + 24 * HOUR);
    // An illegal record with a deadline must not exist by construction; the sweep refuses it anyway.
    await h.reports.create({ ...timed, id: "forged", reason: "illegal", deleteAt: NOW + 1, targetId: "mug" });
    // A due report on a thing that no longer exists closes as already_gone.
    await h.reports.create({ ...timed, id: "ghost", targetId: "ghost", deleteAt: NOW + 2 });

    expect(await sweepDueReports(h.deps, NOW + 23 * HOUR, 10)).toEqual({ due: 2, takenDown: 1, skipped: 1 });
    expect((await h.reports.get("forged"))?.status).toBe("open");
    expect((await h.reports.get("ghost"))?.status).toBe("takedown");
    expect(await h.boards.getElement("friend")).not.toBeNull();

    expect(await sweepDueReports(h.deps, NOW + 25 * HOUR, 0)).toEqual({ due: 0, takenDown: 0, skipped: 0 });
    expect(await sweepDueReports(h.deps, NOW + 25 * HOUR, 10)).toEqual({ due: 2, takenDown: 1, skipped: 1 });
    expect(await h.boards.getElement("friend")).toBeNull();
    expect((await h.reports.get(timed.id))).toMatchObject({ status: "takedown", note: "timed takedown (takedownHours)" });
    expect(await sweepDueReports(h.deps, NOW + 25 * HOUR, 10)).toEqual({ due: 1, takenDown: 0, skipped: 1 });
  });

  it("dismiss never brings back a scene another open report holds on its own", async () => {
    const h = await harness();
    const sceneReport = await h.file(SLUG, { scope: "scene", targetId: "s-both", reason: "illegal" });
    // The pin report finds s-both already hidden and hides s-mug.
    const pinReport = await h.file(SLUG, { scope: "element", targetId: "mug", reason: "inappropriate" });
    expect(pinReport.held).toEqual({ elementIds: ["mug"], sceneIds: ["s-mug"], boardReview: false, storageHold: false });
    const outcome = await dismissReport(pinReport.id, h.deps);
    expect(outcome?.released).toEqual({ elements: 1, scenes: 0, boardReview: false, storage: false });
    expect((await h.boards.listScenes(SLUG)).map((s) => s.id)).toEqual(["s-mug"]);
    expect((await h.boards.getScene("s-both"))?.hidden).toBe(true);
    // The scene report's own dismiss brings it back.
    const second = await dismissReport(sceneReport.id, h.deps);
    expect(second?.released.scenes).toBe(1);
    expect((await h.boards.listScenes(SLUG)).map((s) => s.id)).toEqual(["s-mug", "s-both"]);
  });

  it("a report someone else decided first is left alone: the decision is claimed before anything is touched", async () => {
    const h = await harness();
    const report = await h.file(SLUG, { scope: "element", targetId: "friend", reason: "likeness" });
    // The sweep (or another operator terminal) got there first.
    expect(await h.reports.decide(report.id, { status: "takedown", decidedAt: NOW })).not.toBeNull();
    expect(await dismissReport(report.id, h.deps)).toBeNull();
    expect((await h.boards.getElement("friend"))?.cutoutRef).toBe(`held:${refsOf("friend")[0]}`);
    expect(await takedownReport(report.id, h.deps)).toBeNull();
    expect(await h.boards.getElement("friend")).not.toBeNull();
    expect((await h.reports.get(report.id))?.status).toBe("takedown");
  });

  it("releasing holds keeps the objects another board's open illegal report still holds as evidence", async () => {
    const h = await harness();
    const OTHER = "ZyXwVuTsRqPoNmLkJiHgFe";
    await h.boards.createBoard({ slug: OTHER, title: "Other", counters: emptyBoardCounters(), createdAt: 1_000, version: 0 });
    await h.boards.putParticipant({ ...participant, id: "p2", boardId: OTHER, userId: undefined });
    const srcRefs = [`elements/boards/${OTHER}/src/cutout.png`, `elements/boards/${OTHER}/src/flattened.jpg`];
    for (const ref of srcRefs) await h.store.put(ref, Buffer.from("s"), "image/png");
    const base = { description: "", maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 }, sourcePhotoId: "job", faceFlag: false };
    await h.boards.createElement({ ...base, id: "src", boardId: OTHER, ownerId: "p2", label: "src", cutoutRef: srcRefs[0], flattenedRef: srcRefs[1], createdAt: 1_200 });
    // A library copy on this board shares the other board's bytes (PIN-85).
    await h.boards.createElement({ ...base, id: "copy", boardId: SLUG, ownerId: "p1", label: "copy", cutoutRef: srcRefs[0], flattenedRef: srcRefs[1], sourceElementId: "src", createdAt: 1_250 });
    const theirs = await h.file(OTHER, { scope: "board", reason: "illegal" });
    const mine = await h.file(SLUG, { scope: "board", reason: "illegal" });
    expect(srcRefs.every((ref) => h.store.isHeld(ref))).toBe(true);

    const outcome = await dismissReport(mine.id, h.deps);
    expect(outcome?.released.storage).toBe(true);
    expect(h.store.isHeld(refsOf("mug")[0])).toBe(false);
    // The other board's evidence is not this report's to release.
    expect(srcRefs.every((ref) => h.store.isHeld(ref))).toBe(true);
    expect(await releaseStorageHolds(SLUG, h.deps)).toMatchObject({ kept: 2, failed: 0 });

    await dismissReport(theirs.id, h.deps);
    expect(srcRefs.some((ref) => h.store.isHeld(ref))).toBe(false);
  });

  it("references stay the only board id in a decision's record", async () => {
    const h = await harness();
    const report = await h.file(SLUG, { scope: "board", reason: "inappropriate" });
    const outcome = await dismissReport(report.id, h.deps);
    expect(outcome?.record.reference).toBe(boardReportRef(SLUG));
  });
});
