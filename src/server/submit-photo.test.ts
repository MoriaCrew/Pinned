import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { InMemoryGameRepository } from "../domain/repository";
import type { Game } from "../domain/types";
import { InMemoryDerivativeStore } from "./derivative-store";
import { joinGame } from "./player-session";
import {
  SubmitPhotoError,
  findActiveSubmission,
  getOwnSubmission,
  submitPhoto,
  type SubmitPhotoDependencies,
} from "./submit-photo";

const SECRET = "x".repeat(40);
const SLUG = "game-35";
const NOW = 1_800_000_000_000;

async function makeJpeg(r: number): Promise<Buffer> {
  return sharp({
    create: { width: 80, height: 60, channels: 3, background: { r, g: 40, b: 60 } },
  })
    .jpeg()
    .toBuffer();
}

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: SLUG,
    chainId: "chain-1",
    state: "OPEN",
    
    challenge: "Find the most suspicious object.",
    adminTokenHash: "hash",
    deadlineAt: NOW + 24 * 3600_000,
    entryCount: 0,
    createdAt: NOW - 1000,
    version: 1,
    ...overrides,
  };
}

async function setup(now: () => number = () => NOW) {
  const repository = new InMemoryGameRepository();
  const store = new InMemoryDerivativeStore();
  await repository.createGame(makeGame());
  const deps: SubmitPhotoDependencies = {
    repository,
    store,
    sessionSecret: SECRET,
    now,
    limits: { minIntervalMs: 0 },
  };
  const joined = await joinGame(
    SLUG,
    { displayName: "Ada", posterOptIn: true },
    null,
    { repository, sessionSecret: SECRET, now },
  );
  return { repository, store, deps, cookie: joined.cookieValue, player: joined.player };
}

describe("recordSubmission transactional guard (PIN-43)", () => {
  it("rejects inside the transaction when the game is closed", async () => {
    const { store, deps, cookie, player } = await setup();
    const repository = new InMemoryGameRepository();
    await repository.createGame(makeGame({ state: "REVEAL" }));
    // Simulate the race: call the repository directly with a guard,
    // as submitPhoto now does after its snapshot checks passed.
    await expect(
      repository.recordSubmission(
        {
          id: "late-1",
          gameId: SLUG,
          playerId: player.id,
          workingRef: "tmp/games/x/working.webp",
          objectLabel: "",
          altLabel: "",
          
          
          
          
          safetyFlags: {},
          status: "active",
          labelCount: 0,
          segmentCount: 0,
          submittedAt: NOW,
          version: 1,
        },
        NOW,
        { now: NOW, maxSubmissionsPerPlayer: 12, maxSubmissionsPerGame: 300, minIntervalMs: 0 },
      ),
    ).rejects.toMatchObject({ code: "game_closed" });
    expect(await repository.listSubmissions(SLUG)).toHaveLength(0);
    void store;
    void deps;
    void cookie;
  });
});

describe("submitPhoto (PIN-35)", () => {
  it("stores only the derivative and counts the entry", async () => {
    const { repository, store, deps, cookie } = await setup();
    const result = await submitPhoto(SLUG, cookie, await makeJpeg(10), deps);
    expect(result.outcome).toBe("created");
    expect(result.submission.status).toBe("active");
    expect(result.submission.workingRef).toContain("tmp/games/");

    const stored = await store.get(result.submission.workingRef as string);
    expect(stored).not.toBeNull();
    // WebP derivative, not the uploaded JPEG bytes.
    expect(stored?.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(stored?.subarray(8, 12).toString("ascii")).toBe("WEBP");

    const game = await repository.getGame(SLUG);
    expect(game?.entryCount).toBe(1);

    const own = await getOwnSubmission(SLUG, cookie, deps);
    expect(own?.submission?.id).toBe(result.submission.id);
  });

  it("replacement supersedes the old entry and deletes its derivative", async () => {
    const { repository, store, deps, cookie } = await setup();
    const first = await submitPhoto(SLUG, cookie, await makeJpeg(10), deps);
    const second = await submitPhoto(SLUG, cookie, await makeJpeg(200), deps);
    expect(second.outcome).toBe("replaced");

    const all = await repository.listSubmissions(SLUG);
    expect(all).toHaveLength(2);
    const old = all.find((s) => s.id === first.submission.id);
    expect(old?.status).toBe("superseded");
    expect(old?.supersededAt).toBe(NOW);
    expect(await store.get(first.submission.workingRef as string)).toBeNull();
    expect(await store.get(second.submission.workingRef as string)).not.toBeNull();
    expect(findActiveSubmission(all, second.submission.playerId)?.id).toBe(second.submission.id);
    expect((await repository.getGame(SLUG))?.entryCount).toBe(1);
  });

  it("rejects anonymous, closed-game, and non-photo submissions", async () => {
    const { repository, deps, cookie } = await setup();
    await expect(submitPhoto(SLUG, null, await makeJpeg(1), deps)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      submitPhoto(SLUG, cookie, Buffer.from("definitely not a photo"), deps),
    ).rejects.toMatchObject({ status: 415 });

    const closedDeps = { ...deps, now: () => NOW + 25 * 3600_000 };
    await expect(submitPhoto(SLUG, cookie, await makeJpeg(2), closedDeps)).rejects.toBeInstanceOf(
      SubmitPhotoError,
    );
    await expect(submitPhoto(SLUG, cookie, await makeJpeg(2), closedDeps)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("enforces per-player replacement cap and minimum interval", async () => {
    let now = NOW;
    const { deps, cookie } = await setup(() => now);
    const capped: SubmitPhotoDependencies = {
      ...deps,
      now: () => now,
      limits: { minIntervalMs: 60_000, maxSubmissionsPerPlayer: 2 },
    };
    await submitPhoto(SLUG, cookie, await makeJpeg(1), capped);
    await expect(submitPhoto(SLUG, cookie, await makeJpeg(2), capped)).rejects.toMatchObject({
      status: 429,
    });
    now += 61_000;
    await submitPhoto(SLUG, cookie, await makeJpeg(3), capped);
    now += 61_000;
    await expect(submitPhoto(SLUG, cookie, await makeJpeg(4), capped)).rejects.toMatchObject({
      status: 429,
    });
  });

  it("concurrent same-player submits leave exactly one active entry", async () => {
    const { repository, store, deps, cookie } = await setup();
    const results = await Promise.all([
      submitPhoto(SLUG, cookie, await makeJpeg(11), deps),
      submitPhoto(SLUG, cookie, await makeJpeg(22), deps),
      submitPhoto(SLUG, cookie, await makeJpeg(33), deps),
    ]);
    const all = await repository.listSubmissions(SLUG);
    const actives = all.filter((s) => s.status === "active");
    expect(actives).toHaveLength(1);
    expect(results.map((r) => r.outcome).sort()).toEqual(["created", "replaced", "replaced"]);
    expect((await repository.getGame(SLUG))?.entryCount).toBe(1);
    // Only the surviving derivative remains in storage.
    const remaining = (
      await Promise.all(all.map(async (s) => (await store.get(s.workingRef as string)) !== null))
    ).filter(Boolean);
    expect(remaining).toHaveLength(1);
    expect(await store.get(actives[0].workingRef as string)).not.toBeNull();
  });

  it("concurrent first submits from different players are all counted", async () => {
    const { repository, deps, cookie } = await setup();
    const cookies: string[] = [cookie];
    for (const name of ["Bo", "Cy"]) {
      const joined = await joinGame(
        SLUG,
        { displayName: name, posterOptIn: true },
        null,
        { repository, sessionSecret: SECRET, now: () => NOW },
      );
      cookies.push(joined.cookieValue);
    }
    await Promise.all(
      cookies.map(async (c, index) => submitPhoto(SLUG, c, await makeJpeg(index + 1), deps)),
    );
    const all = await repository.listSubmissions(SLUG);
    expect(all.filter((s) => s.status === "active")).toHaveLength(3);
    expect((await repository.getGame(SLUG))?.entryCount).toBe(3);
  });

  it("two players produce two active entries", async () => {
    const { repository, deps, cookie } = await setup();
    const second = await joinGame(
      SLUG,
      { displayName: "Bo", posterOptIn: false },
      null,
      { repository, sessionSecret: SECRET, now: () => NOW },
    );
    await submitPhoto(SLUG, cookie, await makeJpeg(1), deps);
    await submitPhoto(SLUG, second.cookieValue, await makeJpeg(2), deps);
    expect((await repository.getGame(SLUG))?.entryCount).toBe(2);
  });
});
