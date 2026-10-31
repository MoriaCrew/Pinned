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
  parseConfirmPinsInput,
  resolveElementImage,
  sweepExpiredWorkingCopies,
  sweepStaleDecomposeJobs,
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

describe("roster-fill hardening (PIN-91)", () => {
  it("concurrent first joins cannot race past the Policy roster cap", async () => {
    const h = makeHarness({ participantsPerBoard: 3 });
    const board = await createBoard({ title: "B" }, h.deps);
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        joinBoard(board.slug, { displayName: `Racer ${i}` }, null, h.session),
      ),
    );
    const created = settled.filter((r) => r.status === "fulfilled");
    const refused = settled.filter((r) => r.status === "rejected");
    expect(created).toHaveLength(3);
    expect(refused).toHaveLength(7);
    for (const r of refused) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        name: "BoardApiError",
        status: 409,
      });
    }
    // Refused racers wrote nothing: no ghost roster entries.
    expect(await h.boards.listParticipants(board.slug)).toHaveLength(3);
    expect((await h.boards.getBoard(board.slug))?.counters.participantCount).toBe(3);
  });

  it("failed reclaims write no participant, and members reclaim into a full board", async () => {
    const h = makeHarness({ participantsPerBoard: 1 });
    const board = await createBoard({ title: "B" }, h.deps);
    const first = await joinBoard(
      board.slug,
      { displayName: "Robin", reclaimPin: "1234" },
      null,
      h.session,
    );
    await expect(
      joinBoard(board.slug, { displayName: "Robin", reclaimPin: "0000" }, null, h.session),
    ).rejects.toMatchObject({ status: 401, code: "reclaim_failed" });
    const roster = await h.boards.listParticipants(board.slug);
    expect(roster.map((p) => p.id)).toEqual([first.participant.id]);
    expect((await h.boards.getBoard(board.slug))?.counters.participantCount).toBe(1);
    expect(
      (await h.boards.listEvents(board.slug)).filter(
        (e) => e.type === "participant_joined",
      ),
    ).toHaveLength(1);

    // The board is full for NEW names...
    await expect(
      joinBoard(board.slug, { displayName: "Aye" }, null, h.session),
    ).rejects.toMatchObject({ status: 409 });
    // ...but the existing member still reclaims her own seat.
    const reclaimed = await joinBoard(
      board.slug,
      { displayName: "robin", reclaimPin: "1234" },
      null,
      h.session,
    );
    expect(reclaimed.outcome).toBe("reclaimed");
    expect(reclaimed.participant.id).toBe(first.participant.id);
  });

  it("per-IP new-join budget: creations count, members and reclaims do not", async () => {
    const h = makeHarness({ joinMaxNewPerIp: 2, joinNewWindowMs: 60_000 });
    const board = await createBoard({ title: "B" }, h.deps);
    const home = { clientIp: "192.0.2.10" };

    const mum = await joinBoard(
      board.slug,
      { displayName: "Mum", reclaimPin: "1234" },
      null,
      h.session,
      home,
    );
    await joinBoard(board.slug, { displayName: "Dad" }, null, h.session, home);
    // Budget spent: a third NEW name from this connection is 429
    // and creates nothing.
    await expect(
      joinBoard(board.slug, { displayName: "Spam 1" }, null, h.session, home),
    ).rejects.toMatchObject({ status: 429, code: "join_rate_limited" });
    expect(await h.boards.listParticipants(board.slug)).toHaveLength(2);

    // NAT family parity: Mum renaming on her own cookie and
    // reclaiming from the same IP are not new creations.
    const renamed = await joinBoard(
      board.slug,
      { displayName: "Mum (host)" },
      mum.cookieValue,
      h.session,
      home,
    );
    expect(renamed.outcome).toBe("updated");
    // A failed reclaim stays the uniform PIN-90 reclaim failure,
    // untouched by the join budget, and mints nobody.
    await expect(
      joinBoard(
        board.slug,
        { displayName: "Mum (host)", reclaimPin: "0000" },
        null,
        h.session,
        home,
      ),
    ).rejects.toMatchObject({ status: 401, code: "reclaim_failed" });
    expect(await h.boards.listParticipants(board.slug)).toHaveLength(2);
    const reclaimed = await joinBoard(
      board.slug,
      { displayName: "Mum (host)", reclaimPin: "1234" },
      null,
      h.session,
      home,
    );
    expect(reclaimed.outcome).toBe("reclaimed");
    expect(reclaimed.participant.id).toBe(mum.participant.id);

    // Another connection has its own budget...
    const cousin = await joinBoard(
      board.slug,
      { displayName: "Cousin" },
      null,
      h.session,
      { clientIp: "198.51.100.4" },
    );
    expect(cousin.outcome).toBe("created");
    // ...and the home budget refills once the Policy window rolls.
    h.setNow(T0 + 60_000);
    const gran = await joinBoard(
      board.slug,
      { displayName: "Gran" },
      null,
      h.session,
      home,
    );
    expect(gran.outcome).toBe("created");
    expect(await h.boards.listParticipants(board.slug)).toHaveLength(4);
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
      confirmPins(board.slug, owner, { jobId: job.id, pinIds: "all" }, h.deps),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      confirmPins(board.slug, owner, { jobId: job.id, pinIds: [""] }, h.deps),
    ).rejects.toMatchObject({ status: 400 });
    // Clear is uploader-only too: someone else's empty confirm is the same 404.
    await expect(
      confirmPins(board.slug, other, { jobId: job.id, pinIds: [] }, h.deps),
    ).rejects.toMatchObject({ status: 404 });
    // Working copy survives failed confirms (tap-to-add window).
    expect(await h.store.get(job.workingRef)).not.toBeNull();
    expect(await h.boards.getPin(job.pinIds[0])).not.toBeNull();
  });

  it("keeps none on an empty confirm (Clear, PIN-122): drops every candidate and the working copy", async () => {
    const h = makeHarness();
    const { board, owner } = await makeBoardWithTwo(h);
    const job = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps);
    const result = await confirmPins(board.slug, owner, { jobId: job.id, pinIds: [] }, h.deps);
    expect(result.pinnedPinIds).toEqual([]);
    expect([...result.droppedPinIds].sort()).toEqual([...job.pinIds].sort());
    expect(result.workingCopyDeleted).toBe(true);
    expect(await h.store.get(job.workingRef)).toBeNull();
    const view = await getBoardView(board.slug, owner, h.deps);
    expect(view?.pins).toEqual([]);
    expect(view?.board.counters.pinCount).toBe(0);
    // A second Clear is a harmless no-op.
    const again = await confirmPins(board.slug, owner, { jobId: job.id, pinIds: [] }, h.deps);
    expect(again.droppedPinIds).toEqual([]);
  });

  it("refuses to confirm or clear a photo that is still cutting (409), touching nothing (PIN-122)", async () => {
    const h = makeHarness();
    const { board, owner } = await makeBoardWithTwo(h);
    const job = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps);
    const stored = await h.jobs.get(job.id);
    if (!stored) throw new Error("job missing");
    for (const status of ["running", "pending"] as const) {
      await h.jobs.update({ ...stored, status });
      for (const pinIds of [[], [job.pinIds[0]]]) {
        const err = await confirmPins(board.slug, owner, { jobId: job.id, pinIds }, h.deps).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BoardApiError);
        expect((err as BoardApiError).status).toBe(409);
      }
    }
    // Candidates and the working copy are untouched.
    for (const pinId of job.pinIds) expect((await h.boards.getPin(pinId))?.status).toBe("candidate");
    expect(await h.store.get(job.workingRef)).not.toBeNull();
    // Once it finishes, Clear works.
    await h.jobs.update({ ...stored, status: "ready" });
    const result = await confirmPins(board.slug, owner, { jobId: job.id, pinIds: [] }, h.deps);
    expect([...result.droppedPinIds].sort()).toEqual([...job.pinIds].sort());
  });

  it("still pins leftovers once the working copy is gone (TTL sweep, PIN-122)", async () => {
    const h = makeHarness({ workingCopyTtlHours: 1 });
    const { board, owner } = await makeBoardWithTwo(h);
    const job = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps);
    h.setNow(T0 + 2 * 60 * 60 * 1000);
    expect(await sweepExpiredWorkingCopies(board.slug, h.deps)).toBe(1);
    const jobView = await getJobView(board.slug, job.id, owner, h.deps);
    expect(jobView?.job.workingCopyGone).toBe(true);
    expect(jobView?.pins).toHaveLength(3);

    const keep = job.pinIds.slice(0, 2);
    const result = await confirmPins(board.slug, owner, { jobId: job.id, pinIds: keep }, h.deps);
    expect(result.pinnedPinIds).toEqual(keep);
    expect(result.droppedPinIds).toEqual([job.pinIds[2]]);
    expect(result.workingCopyDeleted).toBe(true);
    const anon = await getBoardView(board.slug, null, h.deps);
    expect(anon?.pins.map((p) => p.id).sort()).toEqual([...keep].sort());
  });

  it("still pins when the working copy object vanished before any sweep marked it", async () => {
    const h = makeHarness();
    const { board, owner } = await makeBoardWithTwo(h);
    const job = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps);
    await h.store.delete(job.workingRef);
    const result = await confirmPins(board.slug, owner, { jobId: job.id, pinIds: job.pinIds }, h.deps);
    expect(result.pinnedPinIds).toHaveLength(3);
    expect(result.workingCopyDeleted).toBe(true);
  });
});

describe("leftovers in the board view (PIN-122)", () => {
  it("tags only the viewer's own candidates with their photo's job id", async () => {
    const h = makeHarness();
    const { board, owner, other } = await makeBoardWithTwo(h);
    const first = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps);
    const second = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps);
    const theirsDone = await uploadPhoto(board.slug, other, await photoBytes(), h.deps);
    const theirs = await uploadPhoto(board.slug, other, await photoBytes(), h.deps);
    await confirmPins(board.slug, owner, { jobId: first.id, pinIds: [first.pinIds[0]] }, h.deps);
    await confirmPins(board.slug, other, { jobId: theirsDone.id, pinIds: [theirsDone.pinIds[0]] }, h.deps);

    const mine = await getBoardView(board.slug, owner, h.deps);
    const byId = new Map(mine?.pins.map((pin) => [pin.id, pin]));
    // Own candidates: the job they came from.
    for (const pinId of second.pinIds) {
      expect(byId.get(pinId)).toMatchObject({ status: "candidate", jobId: second.id });
    }
    // Pinned pins never carry it, mine or theirs.
    expect(byId.get(first.pinIds[0])).toMatchObject({ status: "pinned" });
    expect(byId.get(first.pinIds[0])).not.toHaveProperty("jobId");
    expect(byId.get(theirsDone.pinIds[0])).toMatchObject({ status: "pinned" });
    expect(byId.get(theirsDone.pinIds[0])).not.toHaveProperty("jobId");
    // Someone else's candidates stay invisible (no id, no job).
    for (const pinId of theirs.pinIds) expect(byId.has(pinId)).toBe(false);
    expect(JSON.stringify(mine)).not.toContain(`"${theirs.id}"`);

    // The other participant sees only their own leftovers; anonymous sees none.
    const otherView = await getBoardView(board.slug, other, h.deps);
    const otherCandidates = otherView?.pins.filter((pin) => pin.status === "candidate") ?? [];
    expect(otherCandidates.map((pin) => pin.id).sort()).toEqual([...theirs.pinIds].sort());
    expect(otherCandidates.every((pin) => "jobId" in pin && pin.jobId === theirs.id)).toBe(true);
    expect(JSON.stringify(otherView)).not.toContain(`"${second.id}"`);
    const anon = await getBoardView(board.slug, null, h.deps);
    expect(anon?.pins.some((pin) => "jobId" in pin)).toBe(false);
    expect(JSON.stringify(anon)).not.toContain(`"${second.id}"`);
  });
});

describe("confirm input (PIN-122)", () => {
  it("accepts an empty selection and still rejects malformed ones", () => {
    const policy = resolvePolicy({});
    expect(parseConfirmPinsInput({ jobId: "j", pinIds: [] }, policy)).toEqual({ jobId: "j", pinIds: [] });
    expect(() => parseConfirmPinsInput({ jobId: "j" }, policy)).toThrow(BoardApiError);
    expect(() => parseConfirmPinsInput({ jobId: "", pinIds: [] }, policy)).toThrow(BoardApiError);
    expect(() => parseConfirmPinsInput({ jobId: "j", pinIds: [1] }, policy)).toThrow(BoardApiError);
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

describe("uploadPhoto racing a board delete (PIN-167)", () => {
  it("a delete landing after the upload's own board read answers the unknown-board 404, not a 500", async () => {
    const h = makeHarness();
    const { board, owner } = await makeBoardWithTwo(h);
    const read = h.boards.getBoard.bind(h.boards);
    let reads = 0;
    // The host's delete lands right after uploadPhoto's own read and
    // before the job starter reads the board again.
    h.boards.getBoard = async (slug) => {
      const result = await read(slug);
      if (++reads === 1) await h.boards.deleteBoard(slug, Date.now());
      return result;
    };
    await expect(uploadPhoto(board.slug, owner, await photoBytes(), h.deps)).rejects.toMatchObject({
      name: "BoardApiError",
      status: 404,
    });
    expect(await h.deps.jobs.listForBoard(board.slug)).toEqual([]);
  });
});

describe("idempotent upload + stale-job sweep", () => {
  const UPLOAD_ID = "11111111-2222-4333-8444-555555555555";

  it("replay with the same uploadId returns the existing job without re-running it", async () => {
    const h = makeHarness();
    const { board, owner } = await makeBoardWithTwo(h);
    const first = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps, UPLOAD_ID);
    expect(first.id).toBe(UPLOAD_ID);
    expect(first.status).toBe("ready");
    expect(first.replayed).toBeUndefined();
    const elementsBefore = (await h.boards.listElements(board.slug)).length;

    const second = await uploadPhoto(board.slug, owner, await photoBytes(), h.deps, UPLOAD_ID);
    expect(second.replayed).toBe(true);
    expect(second.status).toBe("ready");
    expect((await h.boards.listElements(board.slug)).length).toBe(elementsBefore);
    expect(await h.jobs.listForBoard(board.slug)).toHaveLength(1);
  });

  it("rejects a malformed uploadId (400 bad_upload_id) and another participant's id (409)", async () => {
    const h = makeHarness();
    const { board, owner, other } = await makeBoardWithTwo(h);
    await expect(
      uploadPhoto(board.slug, owner, await photoBytes(), h.deps, "not-a-uuid"),
    ).rejects.toMatchObject({ status: 400, code: "bad_upload_id" });

    await uploadPhoto(board.slug, owner, await photoBytes(), h.deps, UPLOAD_ID);
    await expect(
      uploadPhoto(board.slug, other, await photoBytes(), h.deps, UPLOAD_ID),
    ).rejects.toMatchObject({ status: 409, code: "upload_conflict" });
  });

  it("sweep fails pending and running jobs past bound + margin, and getJobView shows it", async () => {
    const h = makeHarness();
    const { board, owner } = await makeBoardWithTwo(h);
    const stale = (id: string, status: "pending" | "running") => ({
      id,
      boardId: board.slug,
      participantId: owner.id,
      status,
      workingRef: `tmp/boards/${board.slug}/jobs/${id}/working.webp`,
      promptVersion: "elements.v1",
      elementIds: [],
      pinIds: [],
      faceNote: false,
      failedConceptCount: 0,
      createdAt: T0,
      updatedAt: T0,
    });
    await h.jobs.create(stale("stale-pending", "pending"));
    await h.jobs.create(stale("stale-running", "running"));

    // Not yet stale at T0; stale once past the default bound (141.5s) + margin (60s).
    expect(await sweepStaleDecomposeJobs(board.slug, h.deps)).toBe(0);
    h.setNow(T0 + 300_000);
    expect(await sweepStaleDecomposeJobs(board.slug, h.deps)).toBe(2);
    for (const id of ["stale-pending", "stale-running"]) {
      const job = await h.jobs.get(id);
      expect(job?.status).toBe("failed");
      expect(job?.errorCode).toBe("stale_running");
    }
    const view = await getJobView(board.slug, "stale-running", owner, h.deps);
    expect(view?.job.status).toBe("failed");
  });
});
