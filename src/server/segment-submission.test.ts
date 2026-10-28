import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { InMemoryGameRepository } from "../domain/repository";
import type { Game, Submission } from "../domain/types";
import type { ModelGateway, SamSegment } from "../gateway/model-gateway";
import { InMemoryDerivativeStore } from "./derivative-store";
import { segmentSubmission } from "./segment-submission";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const SLUG = "game-slug";

// Verbatim example record from Meta's public SAM docs (see sam-mask.test.ts).
const DOCS_SEGMENT: SamSegment = {
  id: "0",
  box: { x1: 211, y1: 228, x2: 270, y2: 254, w: 320, h: 334 },
  mask: { height: 27, width: 60, encoding: "~", payload: "!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(" },
};

function makeGame(): Game {
  return {
    id: SLUG, chainId: "chain-1", state: "OPEN", challenge: "Find it.",
    
    adminTokenHash: "h", deadlineAt: NOW + 3_600_000, entryCount: 1, createdAt: NOW, version: 0,
  };
}

function makeSubmission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: "sub-1", gameId: SLUG, playerId: "player-1",
    workingRef: "tmp/games/game-slug/players/player-1/submissions/sub-1/working.webp",
    objectLabel: "rubber duck", altLabel: "toy", 
    safetyFlags: {}, status: "active",
    labelCount: 1, segmentCount: 0, submittedAt: NOW, version: 1, ...overrides,
  };
}

async function setup(segments: SamSegment[], counter = { calls: 0 }) {
  const repository = new InMemoryGameRepository();
  await repository.createChain({ id: "chain-1", gameCount: 1, createdAt: NOW });
  await repository.createGame(makeGame());
  const submission = makeSubmission();
  await repository.putSubmission(submission);
  const store = new InMemoryDerivativeStore();
  const image = await sharp({ create: { width: 320, height: 334, channels: 3, background: "#884422" } }).webp().toBuffer();
  await store.put(submission.workingRef as string, image, "image/webp");
  const gateway: ModelGateway = {
    nameObject: async () => { throw new Error("unused"); },
    segmentObject: async () => { counter.calls += 1; return { segments }; },
  };
  return { repository, store, deps: { repository, store, gateway }, counter };
}

describe("segmentSubmission (PIN-46)", () => {
  it("cuts out, persists a PNG derivative, and is idempotent", async () => {
    const { store, deps, counter } = await setup([DOCS_SEGMENT]);
    const out = await segmentSubmission(SLUG, "sub-1", deps);
    expect(out.outcome).toBe("cutout");
    expect(out.submission.cutoutRef).toContain("cutout.png");
    const cutout = await store.get(out.submission.cutoutRef as string);
    expect(cutout).not.toBeNull();
    const meta = await sharp(Buffer.from(cutout as Buffer)).metadata();
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
    const again = await segmentSubmission(SLUG, "sub-1", deps);
    expect(again.outcome).toBe("already");
    expect(counter.calls).toBe(1);
  });

  it("falls back gracefully when SAM returns nothing usable", async () => {
    const { deps } = await setup([]);
    const out = await segmentSubmission(SLUG, "sub-1", deps);
    expect(out.outcome).toBe("fallback");
    expect(out.submission.cutoutRef).toBeUndefined();
    expect(out.submission.segmentCount).toBe(1);
  });

  it("requires a label first", async () => {
    const { repository, deps } = await setup([DOCS_SEGMENT]);
    const current = (await repository.listSubmissions(SLUG))[0];
    await repository.putSubmission({ ...current, objectLabel: "" });
    await expect(segmentSubmission(SLUG, "sub-1", deps)).rejects.toMatchObject({ status: 409 });
  });
});
