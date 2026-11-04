import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyBoardCounters, type Element, type Participant, type Scene } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { InMemoryReportStore } from "../domain/report-store";
import { boardReportRef } from "../domain/tokens";
import { resolvePolicy } from "../policy/policy";
import { publicBoard } from "./board-api";
import { REPORT_RECEIVED_EVENT, createReport, listBoardObjectRefs, type ReportDeps } from "./board-report";
import { BoardApiError } from "./board-session";
import { InMemoryDerivativeStore } from "./derivative-store";

/**
 * createReport (PIN-270): validate, plan (ADR-004 table), hold, record,
 * announce. Memory ports, a fixed clock, ids from a counter.
 */
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const participant: Participant = { id: "p1", boardId: SLUG, displayName: "Mia", cookieSecretHash: "h", createdAt: 1_100 };
const refsOf = (id: string) => [`elements/boards/${SLUG}/${id}/cutout.png`, `elements/boards/${SLUG}/${id}/flattened.jpg`];

async function harness() {
  const boards = new InMemoryBoardRepository();
  const store = new InMemoryDerivativeStore();
  const reports = new InMemoryReportStore();
  const policy = resolvePolicy({ report: { messageMaxChars: 40 } });
  await boards.createBoard({ slug: SLUG, title: "Party", counters: emptyBoardCounters(), createdAt: 1_000, version: 0 });
  await boards.putParticipant(participant);
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
    imageRef: `scenes/boards/${SLUG}/${id}/scene.webp`, promptVersion: "scene.v1", createdAt: 1_400,
  });
  await boards.putScene(scene("s-mug", ["mug"]));
  await boards.putScene(scene("s-both", ["mug", "friend"]));
  for (const id of ["s-mug", "s-both"]) await store.put(`scenes/boards/${SLUG}/${id}/scene.webp`, Buffer.from("w"), "image/webp");
  // A sibling no record points at (the strip preview, PIN-133).
  await store.put(`scenes/boards/${SLUG}/s-mug/preview.webp`, Buffer.from("p"), "image/webp");
  let ids = 0;
  const deps: ReportDeps = { boards, store, reports, policy, now: () => NOW, newId: () => `rep-${++ids}` };
  return { boards, store, reports, policy, deps };
}

function loggedEvents(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

describe("createReport (PIN-270)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("element by a visitor: holds the pin and its scenes, records exactly that, announces without the slug", async () => {
    const h = await harness();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await createReport(SLUG, { scope: "element", targetId: "mug", reason: "inappropriate", message: "not nice" }, null, h.deps);
    expect(result.held).toBe(true);
    expect(result.record).toEqual({
      id: "rep-1",
      boardId: SLUG,
      reference: boardReportRef(SLUG),
      scope: "element",
      targetId: "mug",
      reason: "inappropriate",
      message: "not nice",
      reporterKind: "visitor",
      severity: "normal",
      createdAt: NOW,
      status: "open",
      held: { elementIds: ["mug"], sceneIds: ["s-mug", "s-both"], boardReview: false, storageHold: false },
    });
    expect(await h.reports.get("rep-1")).toEqual(result.record);
    expect((await h.boards.getElement("mug"))?.cutoutRef).toBe(`held:${refsOf("mug")[0]}`);
    expect((await h.boards.getElement("friend"))?.cutoutRef).toBe(refsOf("friend")[0]);
    expect(await h.boards.listScenes(SLUG)).toEqual([]);
    expect((await h.boards.getBoard(SLUG))?.reviewAt).toBeUndefined();
    const [event] = loggedEvents(log);
    expect(event).toEqual({
      severity: "WARNING",
      event: REPORT_RECEIVED_EVENT,
      reference: boardReportRef(SLUG),
      reason: "inappropriate",
      scope: "element",
      reportSeverity: "normal",
      reporterKind: "visitor",
      held: { elements: 1, scenes: 2, board: false, storage: false },
    });
  });

  it("a likeness report on a face-flagged pin gets the one deadline; without the flag it does not", async () => {
    const h = await harness();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const timed = await createReport(SLUG, { scope: "element", targetId: "friend", reason: "likeness" }, null, h.deps);
    expect(timed.record.deleteAt).toBe(NOW + h.policy.takedownHours * HOUR);
    expect((await h.reports.listOpenDue(NOW + 25 * HOUR, 10)).map((r) => r.id)).toEqual(["rep-1"]);
    const plain = await createReport(SLUG, { scope: "element", targetId: "mug", reason: "likeness" }, null, h.deps);
    expect(plain.record).not.toHaveProperty("deleteAt");
  });

  it("scene: hides that scene only", async () => {
    const h = await harness();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await createReport(SLUG, { scope: "scene", targetId: "s-both", reason: "ownership" }, null, h.deps);
    expect(result.held).toBe(true);
    expect(result.record.held).toEqual({ elementIds: [], sceneIds: ["s-both"], boardReview: false, storageHold: false });
    expect((await h.boards.listScenes(SLUG)).map((s) => s.id)).toEqual(["s-mug"]);
    expect((await h.boards.getElement("mug"))?.cutoutRef).toBe(refsOf("mug")[0]);
  });

  it("whole board by a visitor (not illegal): queued, alerted, nothing hidden", async () => {
    const h = await harness();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await createReport(SLUG, { scope: "board", reason: "inappropriate" }, null, h.deps);
    expect(result.held).toBe(false);
    expect(result.record.held).toEqual({ elementIds: [], sceneIds: [], boardReview: false, storageHold: false });
    expect((await h.boards.listScenes(SLUG)).length).toBe(2);
    const board = await h.boards.getBoard(SLUG);
    expect(board?.reviewAt).toBeUndefined();
    expect(publicBoard(board!).underReview).toBe(false);
    expect(loggedEvents(log)[0]).toMatchObject({ held: { elements: 0, scenes: 0, board: false, storage: false } });
  });

  it("whole board by a participant: everything held, board under review, no storage hold", async () => {
    const h = await harness();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await createReport(SLUG, { scope: "board", reason: "inappropriate" }, participant, h.deps);
    expect(result.held).toBe(true);
    expect(result.record.reporterKind).toBe("participant");
    expect(result.record.held).toEqual({ elementIds: ["mug", "friend"], sceneIds: ["s-mug", "s-both"], boardReview: true, storageHold: false });
    const board = await h.boards.getBoard(SLUG);
    expect(board?.reviewAt).toBe(NOW);
    expect(publicBoard(board!).underReview).toBe(true);
    expect(await h.boards.listScenes(SLUG)).toEqual([]);
    expect(h.store.isHeld(refsOf("mug")[0])).toBe(false);
  });

  it("whole board as illegal from anyone: the same plus Storage holds on whole folders, severity high, CRITICAL line", async () => {
    const h = await harness();
    // A library copy whose bytes live under another board's folder (PIN-85).
    const OTHER = "ZyXwVuTsRqPoNmLkJiHgFe";
    const foreign = [`elements/boards/${OTHER}/src/cutout.png`, `elements/boards/${OTHER}/src/flattened.jpg`, `elements/boards/${OTHER}/src/extra.bin`];
    for (const ref of foreign) await h.store.put(ref, Buffer.from("x"), "image/png");
    await h.boards.createElement({
      id: "copy", boardId: SLUG, ownerId: "p1", label: "copy", description: "", maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
      cutoutRef: foreign[0], flattenedRef: foreign[1], sourcePhotoId: "job", faceFlag: false, sourceElementId: "src", createdAt: 1_250,
    });
    // A working copy must never be held.
    await h.store.put(`tmp/boards/${SLUG}/jobs/j/working.webp`, Buffer.from("t"), "image/webp");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await createReport(SLUG, { scope: "board", reason: "illegal" }, null, h.deps);
    expect(result.record.severity).toBe("high");
    expect(result.record.held).toEqual({ elementIds: ["mug", "friend", "copy"], sceneIds: ["s-mug", "s-both"], boardReview: true, storageHold: true });
    expect(result.record).not.toHaveProperty("deleteAt");
    for (const ref of [
      ...refsOf("mug"),
      ...refsOf("friend"),
      `scenes/boards/${SLUG}/s-mug/scene.webp`,
      `scenes/boards/${SLUG}/s-both/scene.webp`,
      `scenes/boards/${SLUG}/s-mug/preview.webp`,
      ...foreign,
    ]) {
      expect(h.store.isHeld(ref)).toBe(true);
    }
    expect(h.store.isHeld(`tmp/boards/${SLUG}/jobs/j/working.webp`)).toBe(false);
    expect(loggedEvents(log)[0]).toMatchObject({ severity: "CRITICAL", reason: "illegal", held: { storage: true } });
  });

  it("listBoardObjectRefs falls back to the records' refs when a listing fails", async () => {
    const h = await harness();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const elements = await h.boards.listElements(SLUG);
    const scenes = await h.boards.listScenes(SLUG, { includeHidden: true });
    const refs = await listBoardObjectRefs(SLUG, elements, scenes, { listPrefix: async () => { throw new Error("gcs down"); } });
    expect(refs.sort()).toEqual([...refsOf("friend"), ...refsOf("mug"), `scenes/boards/${SLUG}/s-both/scene.webp`, `scenes/boards/${SLUG}/s-mug/scene.webp`].sort());
  });

  it("a Storage hold that fails is logged by name and recorded as not held; the report still lands", async () => {
    const h = await harness();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = h.store.setHold.bind(h.store);
    h.store.setHold = async (ref, held) => {
      if (ref.endsWith("s-both/scene.webp")) throw new Error(`gcs down for ${SLUG}`);
      return original(ref, held);
    };
    const result = await createReport(SLUG, { scope: "board", reason: "illegal" }, null, h.deps);
    expect(result.record.held.storageHold).toBe(false);
    expect(await h.reports.get("rep-1")).not.toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls[0])).not.toContain(SLUG);
  });

  it("never logs the slug or the message; the message stays on the record", async () => {
    const h = await harness();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createReport(SLUG, { scope: "board", reason: "other", message: "the host is my ex" }, participant, h.deps);
    const line = String(log.mock.calls[0][0]);
    expect(line).not.toContain(SLUG);
    expect(line).not.toContain("my ex");
    expect((await h.reports.get("rep-1"))?.message).toBe("the host is my ex");
  });

  it("a bad body is a typed 400 before any read", async () => {
    const h = await harness();
    const cases: [unknown, string][] = [
      [{ scope: "board" }, "report_invalid"],
      [{ scope: "board", reason: "other" }, "report_message_required"],
      [{ scope: "board", reason: "likeness", message: "x".repeat(41) }, "report_message_too_long"],
      [{ scope: "board", reason: "likeness", reporterEmail: "nope" }, "report_email_invalid"],
    ];
    for (const [body, code] of cases) {
      const error = await createReport("ZyXwVuTsRqPoNmLkJiHgFe", body, null, h.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BoardApiError);
      expect((error as BoardApiError).status).toBe(400);
      expect((error as BoardApiError).code).toBe(code);
    }
    const tooLong = await createReport(SLUG, { scope: "board", reason: "likeness", message: "x".repeat(41) }, null, h.deps).catch((e: unknown) => e);
    expect((tooLong as BoardApiError).userMessage).toEqual({ key: "request.reportMessageTooLong", values: { max: 40 } });
    expect(await h.reports.listOpenForBoard(SLUG)).toEqual([]);
  });

  it("an unknown board or target is the uniform 404, and records nothing", async () => {
    const h = await harness();
    for (const [slug, body] of [
      ["ZyXwVuTsRqPoNmLkJiHgFe", { scope: "board", reason: "likeness" }],
      [SLUG, { scope: "element", targetId: "ghost", reason: "likeness" }],
      [SLUG, { scope: "scene", targetId: "ghost", reason: "likeness" }],
    ] as const) {
      const error = await createReport(slug, body, null, h.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BoardApiError);
      expect((error as BoardApiError).status).toBe(404);
    }
    expect(await h.reports.listOpenForBoard(SLUG)).toEqual([]);
    expect((await h.boards.listScenes(SLUG)).length).toBe(2);
  });
});
