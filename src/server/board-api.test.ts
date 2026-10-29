import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { emptyBoardCounters, type Element } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { isValidSlug } from "../domain/tokens";
import { mockElementNamer, mockSegmenter } from "../gateway/mock-ports";
import { resolvePolicy, type PolicyOverrides } from "../policy/policy";
import {
  confirmPins,
  createBoard,
  getBoardView,
  getJobView,
  resolveElementImage,
  sweepExpiredWorkingCopies,
  uploadPhoto,
  type BoardApiDeps,
} from "./board-api";
import {
  BoardApiError,
  joinBoard,
  resolveParticipantSession,
  type BoardSessionDeps,
} from "./board-session";
import { InMemoryDecomposeJobStore } from "./decompose-job";
import { InMemoryDerivativeStore } from "./derivative-store";

const SECRET = "test-secret-test-secret-test-secret-32";
const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);

async function photoBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 320, height: 334, channels: 3, background: { r: 80, g: 120, b: 140 } },
  })
    .png()
    .toBuffer();
}

interface Harness {
  deps: BoardApiDeps;
  session: BoardSessionDeps;
  boards: InMemoryBoardRepository;
  jobs: InMemoryDecomposeJobStore;
  store: InMemoryDerivativeStore;
  setNow(now: number): void;
}

function makeHarness(overrides: PolicyOverrides = {}): Harness {
  const boards = new InMemoryBoardRepository();
  const jobs = new InMemoryDecomposeJobStore();
  const store = new InMemoryDerivativeStore();
  const policy = resolvePolicy(overrides);
  let now = T0;
  let seq = 0;
  const deps: BoardApiDeps = {
    boards,
    jobs,
    store,
    // Real AI_MOCK ports: the mock segment mask must decode (PIN-65).
    namer: mockElementNamer,
    segmenter: mockSegmenter,
    policy,
    now: () => now,
    newId: () => `job-${++seq}`,
  };
  return {
    deps,
    session: { boards, sessionSecret: SECRET, policy, now: () => now },
    boards,
    jobs,
    store,
    setNow(value: number) {
      now = value;
    },
  };
}

async function makeBoardWithTwo(h: Harness) {
  const board = await createBoard({ title: "Family board", themeId: "cat" }, h.deps);
  const owner = await joinBoard(board.slug, { displayName: "Robin" }, null, h.session);
  const other = await joinBoard(board.slug, { displayName: "Aye" }, null, h.session);
  return { board, owner: owner.participant, other: other.participant };
}

describe("createBoard", () => {
  it("creates a board with a capability slug, trimmed title and theme tokens", async () => {
    const h = makeHarness();
    const board = await createBoard({ title: "  My   board ", themeId: "cat" }, h.deps);
    expect(isValidSlug(board.slug)).toBe(true);
    expect(board.title).toBe("My board");
    expect(board.themeId).toBe("cat");
    expect(board.theme?.motif).toBe("🐱");
    expect(await h.boards.getBoard(board.slug)).not.toBeNull();
  });

  it("rejects missing/over-long titles and unknown themes with 400", async () => {
    const h = makeHarness({ boardTitleMaxChars: 5 });
    await expect(createBoard({ title: "" }, h.deps)).rejects.toMatchObject({
      name: "BoardApiError",
      status: 400,
    });
    await expect(createBoard({ title: "123456" }, h.deps)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      createBoard({ title: "ok", themeId: "nope" }, h.deps),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("joinBoard / participant sessions", () => {
  it("creates a participant and the issued cookie resolves back", async () => {
    const h = makeHarness();
    const board = await createBoard({ title: "B" }, h.deps);
    const joined = await joinBoard(
      board.slug,
      { displayName: " Robin ", reclaimPin: "1234" },
      null,
      h.session,
    );
    expect(joined.outcome).toBe("created");
    expect(joined.participant.displayName).toBe("Robin");
    expect(joined.participant.cookieSecretHash).not.toContain(joined.cookieValue);
    const resolved = await resolveParticipantSession(board.slug, joined.cookieValue, h.session);
    expect(resolved?.id).toBe(joined.participant.id);
    // Garbage / wrong-board cookies never resolve.
    expect(await resolveParticipantSession(board.slug, "garbage", h.session)).toBeNull();
    const otherBoard = await createBoard({ title: "C" }, h.deps);
    expect(
      await resolveParticipantSession(otherBoard.slug, joined.cookieValue, h.session),
    ).toBeNull();
  });

  it("reclaims by name + PIN, 404s a missing board, and caps the roster from Policy", async () => {
    const h = makeHarness({ participantsPerBoard: 1 });
    const board = await createBoard({ title: "B" }, h.deps);
    const first = await joinBoard(
      board.slug,
      { displayName: "Robin", reclaimPin: "1234" },
      null,
      h.session,
    );
    const reclaimed = await joinBoard(
      board.slug,
      { displayName: "robin", reclaimPin: "1234" },
      null,
      h.session,
    );
    expect(reclaimed.outcome).toBe("reclaimed");
    expect(reclaimed.participant.id).toBe(first.participant.id);
    await expect(
      joinBoard(board.slug, { displayName: "Aye" }, null, h.session),
    ).rejects.toMatchObject({ name: "BoardApiError", status: 409 });
    await expect(
      joinBoard("no-such-board", { displayName: "Aye" }, null, h.session),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      joinBoard(board.slug, { displayName: "x", reclaimPin: "12" }, null, h.session),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("reclaim hardening (PIN-90)", () => {
  async function failureOf(promise: Promise<unknown>) {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoardApiError);
    const apiError = error as BoardApiError;
    return { status: apiError.status, code: apiError.code, message: apiError.message };
  }

  it("wrong PIN, no-PIN-on-file and locked-out failures are indistinguishable", async () => {
    const h = makeHarness({
      reclaimMaxFailuresPerName: 2,
      reclaimLockoutBaseMs: 60_000,
      reclaimLockoutMaxMs: 60_000,
    });
    const board = await createBoard({ title: "B" }, h.deps);
    await joinBoard(board.slug, { displayName: "Robin", reclaimPin: "1234" }, null, h.session);
    await joinBoard(board.slug, { displayName: "Aye" }, null, h.session);

    const wrongPin = await failureOf(
      joinBoard(board.slug, { displayName: "Robin", reclaimPin: "9999" }, null, h.session),
    );
    const noPinOnFile = await failureOf(
      joinBoard(board.slug, { displayName: "Aye", reclaimPin: "9999" }, null, h.session),
    );
    expect(noPinOnFile).toEqual(wrongPin);
    expect(wrongPin).toMatchObject({ status: 401, code: "reclaim_failed" });

    // Second wrong try hits the Policy threshold and locks Robin;
    // even the correct PIN then fails with the identical shape.
    await failureOf(
      joinBoard(board.slug, { displayName: "Robin", reclaimPin: "9999" }, null, h.session),
    );
    const locked = await failureOf(
      joinBoard(board.slug, { displayName: "Robin", reclaimPin: "1234" }, null, h.session),
    );
    expect(locked).toEqual(wrongPin);

    // Failed reclaims never mint a duplicate participant.
    expect(await h.boards.listParticipants(board.slug)).toHaveLength(2);
  });

  it("first-try reclaim still works, and success clears the failure counters", async () => {
    const h = makeHarness({ reclaimMaxFailuresPerName: 3 });
    const board = await createBoard({ title: "B" }, h.deps);
    const first = await joinBoard(
      board.slug,
      { displayName: "Robin", reclaimPin: "1234" },
      null,
      h.session,
    );
    await failureOf(
      joinBoard(board.slug, { displayName: "Robin", reclaimPin: "0000" }, null, h.session),
    );
    const reclaimed = await joinBoard(
      board.slug,
      { displayName: "robin", reclaimPin: "1234" },
      null,
      h.session,
    );
    expect(reclaimed.outcome).toBe("reclaimed");
    expect(reclaimed.participant.id).toBe(first.participant.id);
    // Counter cleared: two more wrong tries stay under the threshold.
    await failureOf(
      joinBoard(board.slug, { displayName: "Robin", reclaimPin: "0000" }, null, h.session),
    );
    await failureOf(
      joinBoard(board.slug, { displayName: "Robin", reclaimPin: "0000" }, null, h.session),
    );
    const again = await joinBoard(
      board.slug,
      { displayName: "Robin", reclaimPin: "1234" },
      null,
      h.session,
    );
    expect(again.outcome).toBe("reclaimed");
  });

  it("locks at the Policy name threshold and frees after the lock expires", async () => {
    const h = makeHarness({
      reclaimMaxFailuresPerName: 2,
      reclaimLockoutBaseMs: 5_000,
      reclaimLockoutMaxMs: 5_000,
    });
    const board = await createBoard({ title: "B" }, h.deps);
    await joinBoard(board.slug, { displayName: "Robin", reclaimPin: "1234" }, null, h.session);
    await failureOf(
      joinBoard(board.slug, { displayName: "Robin", reclaimPin: "0000" }, null, h.session),
    );
    await failureOf(
      joinBoard(board.slug, { displayName: "Robin", reclaimPin: "0000" }, null, h.session),
    );
    await failureOf(
      joinBoard(board.slug, { displayName: "Robin", reclaimPin: "1234" }, null, h.session),
    );
    h.setNow(T0 + 5_000);
    const reclaimed = await joinBoard(
      board.slug,
      { displayName: "Robin", reclaimPin: "1234" },
      null,
      h.session,
    );
    expect(reclaimed.outcome).toBe("reclaimed");
  });

  it("counts failures per IP across names; a fresh IP is unaffected", async () => {
    const h = makeHarness({
      reclaimMaxFailuresPerName: 50,
      reclaimMaxFailuresPerIp: 2,
      reclaimLockoutBaseMs: 60_000,
      reclaimLockoutMaxMs: 60_000,
    });
    const board = await createBoard({ title: "B" }, h.deps);
    await joinBoard(board.slug, { displayName: "Robin", reclaimPin: "1234" }, null, h.session);
    await joinBoard(board.slug, { displayName: "Aye", reclaimPin: "5678" }, null, h.session);
    const attacker = { clientIp: "203.0.113.7" };
    await failureOf(
      joinBoard(board.slug, { displayName: "Robin", reclaimPin: "0000" }, null, h.session, attacker),
    );
    await failureOf(
      joinBoard(board.slug, { displayName: "Aye", reclaimPin: "0000" }, null, h.session, attacker),
    );
    // IP locked at its Policy threshold even though no name is.
    await failureOf(
      joinBoard(board.slug, { displayName: "Robin", reclaimPin: "1234" }, null, h.session, attacker),
    );
    const reclaimed = await joinBoard(
      board.slug,
      { displayName: "Robin", reclaimPin: "1234" },
      null,
      h.session,
      { clientIp: "198.51.100.9" },
    );
    expect(reclaimed.outcome).toBe("reclaimed");
  });

  it("normal join parity: no-PIN join and first join with a fresh name + PIN still create", async () => {
    const h = makeHarness();
    const board = await createBoard({ title: "B" }, h.deps);
    const plain = await joinBoard(board.slug, { displayName: "Robin" }, null, h.session);
    expect(plain.outcome).toBe("created");
    const withPin = await joinBoard(
      board.slug,
      { displayName: "Aye", reclaimPin: "4321" },
      null,
      h.session,
    );
    expect(withPin.outcome).toBe("created");
    expect(withPin.participant.reclaimPinHash).toBeTruthy();
    expect(withPin.participant.reclaimPinHash).not.toContain("4321");
  });
});

describe("uploadPhoto -> job -> confirmPins (A6a)", () => {
  it("runs the mock decompose to ready, confirms a subset, drops the rest and deletes the working copy", async () => {
    const h = makeHarness();
    const { board, owner, other } = await makeBoardWithTwo(h);
    const original = await photoBytes();

    const job = await uploadPhoto(board.slug, owner, original, h.deps);
    expect(job.status).toBe("ready");
    expect(job.pinIds.length).toBe(3); // the three AI_MOCK elements
    const stored = await h.jobs.get(job.id);
    expect(stored?.workingDeletedAt).toBeUndefined();
    const working = await h.store.get(job.workingRef);
    expect(working).not.toBeNull();
    expect(working?.equals(Buffer.from(original))).toBe(false); // derivative, never the original
    expect(job.workingRef.startsWith("tmp/")).toBe(true);

    // Job poll: uploader only.
    const ownerView = await getJobView(board.slug, job.id, owner, h.deps);
    expect(ownerView?.pins).toHaveLength(3);
    expect(ownerView?.elements[0].imageUrl).toContain("/elements/");
    expect(await getJobView(board.slug, job.id, other, h.deps)).toBeNull();
    expect(await getJobView(board.slug, job.id, null, h.deps)).toBeNull();
    expect(await getJobView("other-board", job.id, owner, h.deps)).toBeNull();

    // Candidates are private pre-confirm; pinned pins become link-public.
    const anonBefore = await getBoardView(board.slug, null, h.deps);
    expect(anonBefore?.pins).toHaveLength(0);
    const ownerBefore = await getBoardView(board.slug, owner, h.deps);
    expect(ownerBefore?.pins).toHaveLength(3);

    const keep = job.pinIds[0];
    const result = await confirmPins(board.slug, owner, { jobId: job.id, pinIds: [keep] }, h.deps);
    expect(result.pinnedPinIds).toEqual([keep]);
    expect(result.droppedPinIds).toHaveLength(2);
    expect(result.workingCopyDeleted).toBe(true);
    // A6a asserted: the working copy object is gone.
    expect(await h.store.get(job.workingRef)).toBeNull();
    expect((await h.jobs.get(job.id))?.workingDeletedAt).toBe(T0);
    expect((await h.boards.getPin(keep))?.status).toBe("pinned");
    for (const dropped of result.droppedPinIds) {
      expect(await h.boards.getPin(dropped)).toBeNull();
    }
    const anonAfter = await getBoardView(board.slug, null, h.deps);
    expect(anonAfter?.pins.map((p) => p.id)).toEqual([keep]);
    expect(anonAfter?.elements).toHaveLength(1);
    expect(anonAfter?.board.counters.pinCount).toBe(1);

    // Idempotent re-confirm: no throw, still deleted.
    const again = await confirmPins(board.slug, owner, { jobId: job.id, pinIds: [keep] }, h.deps);
    expect(again.workingCopyDeleted).toBe(true);
    expect((await h.boards.getPin(keep))?.status).toBe("pinned");
  });

  it("404s another participant's job on confirm and 400s pins outside the job", async () => {
    const h = makeHarness();
    const { board, owner, other } = await makeBoardWithTwo(h);
    const job = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps);
    await expect(
      confirmPins(board.slug, other, { jobId: job.id, pinIds: [job.pinIds[0]] }, h.deps),
    ).rejects.toMatchObject({ name: "BoardApiError", status: 404 });
    await expect(
      confirmPins(board.slug, owner, { jobId: job.id, pinIds: ["not-a-pin"] }, h.deps),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      confirmPins(board.slug, owner, { jobId: job.id, pinIds: [] }, h.deps),
    ).rejects.toMatchObject({ status: 400 });
    // Working copy survives failed confirms (tap-to-add window).
    expect(await h.store.get(job.workingRef)).not.toBeNull();
  });

  it("enforces Policy.photosPerParticipantPerDay with a 429 before any intake", async () => {
    const h = makeHarness({ photosPerParticipantPerDay: 1 });
    const { board, owner } = await makeBoardWithTwo(h);
    await uploadPhoto(board.slug, owner, await photoBytes(), h.deps);
    const error = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BoardApiError);
    expect(error).toMatchObject({ status: 429, code: "photos_per_day" });
    expect(await h.jobs.listForBoard(board.slug)).toHaveLength(1);
    // Next UTC day frees the cap again.
    h.setNow(T0 + 24 * 60 * 60 * 1000);
    const job2 = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps);
    expect(job2.status).toBe("ready");
  });
});

describe("activity strip in the board view (PIN-74)", () => {
  it("shows joins then the pinned line, newest first, capped by Policy.activityStripMax", async () => {
    const h = makeHarness({ activityStripMax: 2 });
    const { board, owner } = await makeBoardWithTwo(h);
    const job = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps);

    // Unconfirmed candidates stay out of the strip: only the two
    // joins are activity so far, and the cap keeps the newest two.
    const before = await getBoardView(board.slug, null, h.deps);
    expect(before?.activity.map((a) => a.kind)).toEqual(["joined", "joined"]);

    await confirmPins(board.slug, owner, { jobId: job.id, pinIds: [job.pinIds[0]] }, h.deps);
    const after = await getBoardView(board.slug, null, h.deps);
    expect(after?.activity).toHaveLength(2);
    expect(after?.activity[0].kind).toBe("pinned");
    expect(after?.activity[0].label).toBeTruthy();
    expect(after?.activity[0].actorName).toBe(owner.displayName);
  });

  it("is empty on a brand-new board with no participants yet", async () => {
    const h = makeHarness();
    const board = await createBoard({ title: "Fresh" }, h.deps);
    const view = await getBoardView(board.slug, null, h.deps);
    expect(view?.activity).toEqual([]);
  });
});

describe("sweepExpiredWorkingCopies (A6a TTL hook)", () => {
  it("deletes only working copies past Policy.workingCopyTtlHours", async () => {
    const h = makeHarness({ workingCopyTtlHours: 2 });
    const { board, owner } = await makeBoardWithTwo(h);
    const job = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps);

    h.setNow(T0 + 60 * 60 * 1000); // +1h: still inside TTL
    expect(await sweepExpiredWorkingCopies(board.slug, h.deps)).toBe(0);
    expect(await h.store.get(job.workingRef)).not.toBeNull();

    h.setNow(T0 + 3 * 60 * 60 * 1000); // +3h: past TTL
    expect(await sweepExpiredWorkingCopies(board.slug, h.deps)).toBe(1);
    expect(await h.store.get(job.workingRef)).toBeNull();
    expect((await h.jobs.get(job.id))?.workingDeletedAt).toBe(T0 + 3 * 60 * 60 * 1000);
    // Second sweep is a no-op.
    expect(await sweepExpiredWorkingCopies(board.slug, h.deps)).toBe(0);
  });
});

describe("resolveElementImage (board-link-checked, uniform miss)", () => {
  it("serves cut-out and flattened bytes only for elements of that board", async () => {
    const h = makeHarness();
    const { board, owner } = await makeBoardWithTwo(h);
    const otherBoard = await createBoard({ title: "Elsewhere" }, h.deps);
    const job = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps);
    const elementId = job.elementIds[0];

    const cutout = await resolveElementImage(board.slug, elementId, "cutout", h.deps);
    expect(cutout?.contentType).toBe("image/png");
    expect(cutout?.bytes.length).toBeGreaterThan(0);
    const flat = await resolveElementImage(board.slug, elementId, "flattened", h.deps);
    expect(flat?.contentType).toBe("image/jpeg");

    // Every miss collapses to null -> one uniform 404 at the route.
    expect(await resolveElementImage(otherBoard.slug, elementId, "cutout", h.deps)).toBeNull();
    expect(await resolveElementImage(board.slug, "missing", "cutout", h.deps)).toBeNull();
    expect(await resolveElementImage(board.slug, elementId, "working", h.deps)).toBeNull();
    expect(await resolveElementImage(board.slug, elementId, null, h.deps)).toBeNull();
    expect(await resolveElementImage("no-such-board", elementId, "cutout", h.deps)).toBeNull();
  });

  it("never serves a tmp/ ref even if an element record points at one", async () => {
    const h = makeHarness();
    const { board, owner } = await makeBoardWithTwo(h);
    const forged: Element = {
      id: "forged",
      boardId: board.slug,
      ownerId: owner.id,
      label: "Forged",
      description: "points at tmp",
      maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
      cutoutRef: "tmp/boards/secret/working.webp",
      flattenedRef: "tmp/boards/secret/working.webp",
      sourcePhotoId: "x",
      faceFlag: false,
      createdAt: T0,
    };
    await h.boards.createElement(forged);
    await h.store.put("tmp/boards/secret/working.webp", Buffer.from("secret"), "image/webp");
    expect(await resolveElementImage(board.slug, "forged", "cutout", h.deps)).toBeNull();
    expect(emptyBoardCounters().pinCount).toBe(0);
  });
});
