import { describe, expect, it } from "vitest";
import { InMemoryGameRepository, VersionConflictError } from "./repository";
import type { Game } from "./types";

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: "slug-1",
    chainId: "chain-1",
    state: "OPEN",
    brief: "brief",
    challenge: "challenge",
    persona: { name: "H", language: "en", voiceRules: [], catchphrases: [], judgingStyle: "dry" },
    adminTokenHash: "hash",
    deadlineAt: 1_000,
    entryCount: 0,
    createdAt: 0,
    version: 0,
    ...overrides,
  };
}

describe("InMemoryGameRepository", () => {
  it("creates and reads back an isolated copy", async () => {
    const repo = new InMemoryGameRepository();
    await repo.createGame(makeGame());
    const read = await repo.getGame("slug-1");
    expect(read?.id).toBe("slug-1");
    read!.state = "CLOSED";
    expect((await repo.getGame("slug-1"))?.state).toBe("OPEN");
  });

  it("duplicate create throws", async () => {
    const repo = new InMemoryGameRepository();
    await repo.createGame(makeGame());
    await expect(repo.createGame(makeGame())).rejects.toThrow(RangeError);
  });

  it("deadline vs force-close race: loser is an idempotent no-op", async () => {
    const repo = new InMemoryGameRepository();
    await repo.createGame(makeGame());
    const first = await repo.compareAndSetGameState("slug-1", 0, "REVEAL", 10);
    expect(first.changed).toBe(true);
    const second = await repo.compareAndSetGameState("slug-1", 0, "REVEAL", 11);
    expect(second.changed).toBe(false);
    expect(second.game.version).toBe(1);
  });

  it("stale version to a different state throws VersionConflictError", async () => {
    const repo = new InMemoryGameRepository();
    await repo.createGame(makeGame());
    await repo.compareAndSetGameState("slug-1", 0, "REVEAL", 10);
    await expect(repo.compareAndSetGameState("slug-1", 0, "CLOSED", 11)).rejects.toThrow(
      VersionConflictError,
    );
  });

  it("stores chains and rejects duplicates", async () => {
    const repo = new InMemoryGameRepository();
    const chain = { id: "chain-1", gameCount: 1, createdAt: 0 };
    await repo.createChain(chain);
    expect(await repo.getChain("chain-1")).toEqual(chain);
    await expect(repo.createChain(chain)).rejects.toThrow(RangeError);
  });

  it("stores players, submissions and day-bucketed AI logs", async () => {
    const repo = new InMemoryGameRepository();
    await repo.putPlayer({
      id: "p1",
      gameId: "slug-1",
      displayName: "Ana",
      cookieSecretHash: "h",
      roastLevel: "spicy",
      posterOptIn: true,
      createdAt: 0,
    });
    expect((await repo.getPlayer("slug-1", "p1"))?.displayName).toBe("Ana");
    await repo.appendAiCallLog({
      id: "l1",
      operation: "judgePhoto",
      model: "m",
      latencyMs: 5,
      outcome: "ok",
      dayBucket: "2026-10-26",
      createdAt: 0,
    });
    expect(await repo.listAiCallLogs("2026-10-26")).toHaveLength(1);
    expect(await repo.listAiCallLogs("2026-10-27")).toHaveLength(0);
    expect(await repo.listSubmissions("slug-1")).toHaveLength(0);
  });
});
