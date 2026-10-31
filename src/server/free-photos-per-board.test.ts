import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { InMemoryCreditLedgerStore } from "../domain/credit-ledger";
import { FREE_PHOTOS_USED } from "../domain/free-photos";
import { makerKey } from "../domain/maker-key";
import { grantPlus, type PlusMode } from "../domain/plus";
import { InMemoryStarterAllowanceStore } from "../domain/starter-allowance";
import { mockElementNamer, mockSegmenter } from "../gateway/mock-ports";
import type { ElementNamer } from "../gateway/ports";
import { resolvePolicy, type PolicyOverrides } from "../policy/policy";
import {
  createBoardWithHost,
  getBoardView,
  uploadPhoto,
  type BoardApiDeps,
  type CreateBoardContext,
} from "./board-api";
import { joinBoard } from "./board-session";
import { InMemoryDecomposeJobStore, decomposeBoundMs } from "./decompose-job";
import { InMemoryDerivativeStore } from "./derivative-store";

/**
 * Free photos per board (PIN-230, docs/15 "Free photos rule"):
 * with credits on, a free board cuts credits.freePhotosPerBoard
 * photos (ready or still cutting count; failed/refused never), then
 * gets a typed 429 before any AI call. Plus lifts the limit; a board
 * past its maker's free boards gets 0; credits off changes nothing.
 */
const SECRET = "test-secret-test-secret-test-secret-32";
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);
const MAKER: CreateBoardContext = { makerKey: makerKey({ clientIp: "203.0.113.7" }) };

async function photoBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 320, height: 334, channels: 3, background: { r: 80, g: 120, b: 140 } },
  })
    .png()
    .toBuffer();
}

function harness(overrides: PolicyOverrides, opts: { plusMode?: PlusMode } = {}) {
  const boards = new InMemoryBoardRepository();
  const jobs = new InMemoryDecomposeJobStore();
  const policy = resolvePolicy(overrides);
  let now = T0;
  let namerCalls = 0;
  let namerImpl: ElementNamer = mockElementNamer;
  const deps: BoardApiDeps = {
    boards,
    jobs,
    store: new InMemoryDerivativeStore(),
    namer: {
      async nameElements(input) {
        namerCalls += 1;
        return namerImpl.nameElements(input);
      },
    },
    segmenter: mockSegmenter,
    credits: new InMemoryCreditLedgerStore(),
    starterAllowance: new InMemoryStarterAllowanceStore(),
    policy,
    plusMode: opts.plusMode ?? "stripe",
    now: () => now,
  };
  return {
    deps,
    boards,
    jobs,
    policy,
    get namerCalls() {
      return namerCalls;
    },
    setNamer(n: ElementNamer) {
      namerImpl = n;
    },
    advance(ms: number) {
      now += ms;
    },
    async board(context?: CreateBoardContext) {
      const { board } = await createBoardWithHost({ title: "Photo board" }, deps, context);
      const owner = await joinBoard(board.slug, { displayName: "Robin" }, null, {
        boards,
        sessionSecret: SECRET,
        policy,
        now: () => now,
      });
      return { slug: board.slug, owner: owner.participant };
    },
  };
}

const ON = (freePhotosPerBoard: number, extra: PolicyOverrides["credits"] = {}): PolicyOverrides => ({
  credits: { enabled: true, starterMakes: 5, freePhotosPerBoard, ...extra },
});

async function freePhotosLeftOf(h: ReturnType<typeof harness>, slug: string) {
  return (await getBoardView(slug, null, h.deps))?.credits?.freePhotosLeft;
}

describe("free photos per board (PIN-230)", () => {
  it("a free board cuts its free photos, then the next photo is refused before any AI call", async () => {
    const h = harness(ON(2));
    const { slug, owner } = await h.board();
    expect(await freePhotosLeftOf(h, slug)).toBe(2);

    for (let i = 0; i < 2; i += 1) {
      expect((await uploadPhoto(slug, owner, await photoBytes(), h.deps)).status).toBe("ready");
    }
    expect(await freePhotosLeftOf(h, slug)).toBe(0);
    const calls = h.namerCalls;
    await expect(uploadPhoto(slug, owner, await photoBytes(), h.deps)).rejects.toMatchObject({
      name: "BoardApiError",
      status: 429,
      code: FREE_PHOTOS_USED,
    });
    expect(h.namerCalls).toBe(calls);
    expect(await h.jobs.listForBoard(slug)).toHaveLength(2);
  });

  it("failed photos never count", async () => {
    const h = harness(ON(1));
    const { slug, owner } = await h.board();
    h.setNamer({
      async nameElements() {
        return { status: "failed", errorCode: "http_500", httpStatus: 500 };
      },
    });
    expect((await uploadPhoto(slug, owner, await photoBytes(), h.deps)).status).toBe("failed");
    expect(await freePhotosLeftOf(h, slug)).toBe(1);
    h.setNamer(mockElementNamer);
    expect((await uploadPhoto(slug, owner, await photoBytes(), h.deps)).status).toBe("ready");
    await expect(uploadPhoto(slug, owner, await photoBytes(), h.deps)).rejects.toMatchObject({
      code: FREE_PHOTOS_USED,
    });
  });

  it("a live in-flight photo holds a slot; a stale one does not", async () => {
    const h = harness(ON(1));
    const { slug, owner } = await h.board();
    await h.jobs.create({
      id: "job-live",
      boardId: slug,
      participantId: owner.id,
      status: "running",
      workingRef: `tmp/boards/${slug}/jobs/job-live/working.webp`,
      promptVersion: "elements.v1",
      elementIds: [],
      pinIds: [],
      faceNote: false,
      failedConceptCount: 0,
      createdAt: T0,
      updatedAt: T0,
    });
    await expect(uploadPhoto(slug, owner, await photoBytes(), h.deps)).rejects.toMatchObject({
      code: FREE_PHOTOS_USED,
    });
    h.advance(decomposeBoundMs(h.policy) + 2 * h.policy.staleJobMarginMs + 1);
    expect(await freePhotosLeftOf(h, slug)).toBe(1);
    expect((await uploadPhoto(slug, owner, await photoBytes(), h.deps)).status).toBe("ready");
  });

  it("comes before the daily cap (waiting a day would not help)", async () => {
    const h = harness({ ...ON(1), photosPerParticipantPerDay: 1 });
    const { slug, owner } = await h.board();
    await uploadPhoto(slug, owner, await photoBytes(), h.deps);
    await expect(uploadPhoto(slug, owner, await photoBytes(), h.deps)).rejects.toMatchObject({
      code: FREE_PHOTOS_USED,
    });
  });

  it("a lost-response replay of a counted photo still answers with its job", async () => {
    const h = harness(ON(1));
    const { slug, owner } = await h.board();
    const uploadId = "0b6f1c2a-3d4e-4f50-8a6b-7c8d9e0f1a2b";
    const first = await uploadPhoto(slug, owner, await photoBytes(), h.deps, uploadId);
    const replay = await uploadPhoto(slug, owner, await photoBytes(), h.deps, uploadId);
    expect(replay.id).toBe(first.id);
  });

  it("Plus lifts the limit and the view drops the field; a demo grant only counts in mock mode", async () => {
    const h = harness(ON(1));
    const { slug, owner } = await h.board();
    await uploadPhoto(slug, owner, await photoBytes(), h.deps);
    await h.boards.updateBoardSettings(slug, () => ({ plus: grantPlus("board", "stripe", T0) }));
    expect((await uploadPhoto(slug, owner, await photoBytes(), h.deps)).status).toBe("ready");
    const view = await getBoardView(slug, null, h.deps);
    expect(view?.credits).toBeDefined();
    expect(view?.credits).not.toHaveProperty("freePhotosLeft");

    const demo = harness(ON(1), { plusMode: "off" });
    const board = await demo.board();
    await demo.boards.updateBoardSettings(board.slug, () => ({ plus: grantPlus("board", "mock", T0) }));
    await uploadPhoto(board.slug, board.owner, await photoBytes(), demo.deps);
    await expect(uploadPhoto(board.slug, board.owner, await photoBytes(), demo.deps)).rejects.toMatchObject({
      code: FREE_PHOTOS_USED,
    });
  });

  it("board creation decides free photos with the maker slot: past the maker's free boards, 0", async () => {
    const h = harness(ON(2, { starterBoardsPerMaker: 1 }));
    const first = await h.board(MAKER);
    expect((await h.boards.getBoard(first.slug))?.freePhotos).toBe(2);
    const second = await h.board(MAKER);
    expect((await h.boards.getBoard(second.slug))).toMatchObject({ starterMakes: 0, freePhotos: 0 });
    expect(await freePhotosLeftOf(h, second.slug)).toBe(0);
    await expect(uploadPhoto(second.slug, second.owner, await photoBytes(), h.deps)).rejects.toMatchObject({
      code: FREE_PHOTOS_USED,
    });
    // No maker context (older callers): nothing stored, the Policy amount applies.
    const legacy = await h.board();
    expect(await h.boards.getBoard(legacy.slug)).not.toHaveProperty("freePhotos");
    expect(await freePhotosLeftOf(h, legacy.slug)).toBe(2);
  });

  it("credits off: no gate, no field, nothing stored", async () => {
    const h = harness({ credits: { freePhotosPerBoard: 0 } });
    const { slug, owner } = await h.board(MAKER);
    expect(await h.boards.getBoard(slug)).not.toHaveProperty("freePhotos");
    expect((await uploadPhoto(slug, owner, await photoBytes(), h.deps)).status).toBe("ready");
    expect(await getBoardView(slug, null, h.deps)).not.toHaveProperty("credits");
  });
});
