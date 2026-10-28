import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { InMemoryGameRepository } from "../domain/repository";
import type { Game, Submission } from "../domain/types";
import type { ModelGateway, SamSegment } from "../gateway/model-gateway";
import { InMemoryDerivativeStore } from "./derivative-store";
import { joinGame } from "./player-session";
import { confirmCutout, parseCutoutAction } from "./confirm-cutout";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const SLUG = "game-slug";
const SECRET = "test-session-secret-that-is-long-enough";
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

async function setup() {
  const repository = new InMemoryGameRepository();
  await repository.createChain({ id: "chain-1", gameCount: 1, createdAt: NOW });
  await repository.createGame(makeGame());
  const store = new InMemoryDerivativeStore();
  const joined = await joinGame(SLUG, { displayName: "Robin", posterOptIn: true }, null, {
    repository, sessionSecret: SECRET, now: () => NOW, createPlayerId: () => "player-1",
  });
  const submission: Submission = {
    id: "sub-1", gameId: SLUG, playerId: "player-1",
    workingRef: "tmp/games/game-slug/players/player-1/submissions/sub-1/working.webp",
    cutoutRef: "tmp/games/game-slug/players/player-1/submissions/sub-1/cutout.png",
    objectLabel: "rubber duck", altLabel: "toy", 
    safetyFlags: {}, status: "active",
    labelCount: 1, segmentCount: 1, submittedAt: NOW, version: 1,
  };
  await repository.putSubmission(submission);
  const image = await sharp({ create: { width: 320, height: 334, channels: 3, background: "#884422" } }).webp().toBuffer();
  await store.put(submission.workingRef as string, image, "image/webp");
  await store.put(submission.cutoutRef as string, new Uint8Array([9]), "image/png");
  const gateway: ModelGateway = {
    nameObject: async () => { throw new Error("unused"); },
    segmentObject: async () => ({ segments: [DOCS_SEGMENT] }),
  };
  const deps = { repository, store, gateway, sessionSecret: SECRET };
  return { deps, cookie: joined.cookieValue, store, repository };
}

describe("confirmCutout (PIN-47)", () => {
  it("parses actions and rejects junk", () => {
    expect(parseCutoutAction({ action: "accept" })).toEqual({ action: "accept" });
    expect(parseCutoutAction({ action: "point", point: { x: 0.5, y: 0.25 } })).toEqual({ action: "point", point: { x: 0.5, y: 0.25 } });
    expect(() => parseCutoutAction({ action: "point", point: { x: 2, y: 0 } })).toThrow();
    expect(() => parseCutoutAction(null)).toThrow();
  });

  it("accepts, drops to whole photo, and tap-reselects within the cap", async () => {
    const { deps, cookie, store } = await setup();
    const accepted = await confirmCutout(SLUG, cookie, { action: "accept" }, deps);
    expect(accepted.outcome).toBe("accepted");

    const reselected = await confirmCutout(SLUG, cookie, { action: "point", point: { x: 0.75, y: 0.72 } }, deps);
    expect(reselected.outcome).toBe("cutout");
    expect(reselected.submission.segmentCount).toBe(2);

    const whole = await confirmCutout(SLUG, cookie, { action: "whole" }, deps);
    expect(whole.outcome).toBe("whole");
    expect(whole.submission.cutoutRef).toBeUndefined();
    expect(await store.get("tmp/games/game-slug/players/player-1/submissions/sub-1/cutout.png")).toBeNull();

    await expect(confirmCutout(SLUG, "bogus", { action: "accept" }, deps)).rejects.toMatchObject({ status: 401 });
  });
});
