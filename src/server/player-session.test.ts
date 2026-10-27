import { describe, expect, it } from "vitest";
import { InMemoryGameRepository } from "../domain/repository";
import type { Game } from "../domain/types";
import {
  PlayerJoinError,
  buildPlayerCookieHeader,
  joinGame,
  parseJoinGameInput,
  playerCookieName,
  publicPlayer,
  readCookieValue,
  resolvePlayerSession,
} from "./player-session";

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const SECRET = "test-session-secret-that-is-long-enough";

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: "game-slug",
    chainId: "chain-1",
    state: "OPEN",
    brief: "brief",
    challenge: "Find an object.",
    persona: { name: "Host", language: "en", voiceRules: [], catchphrases: [], judgingStyle: "dry" },
    adminTokenHash: "hash",
    deadlineAt: NOW + 3_600_000,
    entryCount: 0,
    createdAt: NOW,
    version: 0,
    ...overrides,
  };
}

async function setup(overrides: Partial<Game> = {}) {
  const repository = new InMemoryGameRepository();
  await repository.createChain({ id: "chain-1", gameCount: 1, createdAt: NOW });
  await repository.createGame(makeGame(overrides));
  let nextId = 0;
  const deps = {
    repository,
    sessionSecret: SECRET,
    now: () => NOW,
    createPlayerId: () => `player-${++nextId}`,
  };
  return { repository, deps };
}

describe("player sessions", () => {
  it("creates a player, hashes secrets, and resolves only the current cookie", async () => {
    const { repository, deps } = await setup();
    const result = await joinGame("game-slug", {
      displayName: " Robin ",
      posterOptIn: false,
      reclaimPin: "1234",
    }, null, deps);

    expect(result.outcome).toBe("created");
    expect(result.player.displayName).toBe("Robin");
    expect(result.player.cookieSecretHash).not.toContain(result.cookieValue);
    expect(result.player.reclaimPinHash).not.toContain("1234");
    expect(publicPlayer(result.player)).not.toHaveProperty("cookieSecretHash");
    expect(await resolvePlayerSession("game-slug", result.cookieValue, deps))
      .toMatchObject({ id: "player-1" });

    const tampered = `${result.cookieValue}x`;
    expect(await resolvePlayerSession("game-slug", tampered, deps)).toBeNull();
    expect(await repository.listPlayers("game-slug")).toHaveLength(1);
  });

  it("updates the same player and revokes the previous cookie", async () => {
    const { deps } = await setup();
    const first = await joinGame("game-slug", { displayName: "Robin" }, null, deps);
    const second = await joinGame("game-slug", {
      displayName: "Robin R",
      posterOptIn: true,
    }, first.cookieValue, deps);

    expect(second.outcome).toBe("updated");
    expect(second.player.id).toBe(first.player.id);
    expect(second.cookieValue).not.toBe(first.cookieValue);
    expect(await resolvePlayerSession("game-slug", first.cookieValue, deps)).toBeNull();
    expect(await resolvePlayerSession("game-slug", second.cookieValue, deps))
      .toMatchObject({ displayName: "Robin R" });
  });

  it("reclaims by display name plus PIN and keeps distinct players distinct", async () => {
    const { repository, deps } = await setup();
    const first = await joinGame("game-slug", {
      displayName: "Ana",
      reclaimPin: "9876",
    }, null, deps);
    const other = await joinGame("game-slug", { displayName: "Ben" }, null, deps);
    const reclaimed = await joinGame("game-slug", {
      displayName: "ana",
      reclaimPin: "9876",
    }, null, deps);

    expect(other.player.id).not.toBe(first.player.id);
    expect(reclaimed.outcome).toBe("reclaimed");
    expect(reclaimed.player.id).toBe(first.player.id);
    expect(await resolvePlayerSession("game-slug", first.cookieValue, deps)).toBeNull();
    expect(await repository.listPlayers("game-slug")).toHaveLength(2);
  });

  it("rejects closed/expired games and invalid join input", async () => {
    const { deps } = await setup({ state: "REVEAL" });
    await expect(joinGame("game-slug", { displayName: "Robin" }, null, deps))
      .rejects.toMatchObject({ status: 409 });
    expect(() => parseJoinGameInput({ displayName: "" }))
      .toThrow(PlayerJoinError);
    expect(() => parseJoinGameInput({ displayName: "x", reclaimPin: "12" }))
      .toThrow(PlayerJoinError);
  });

  it("builds a game-scoped HttpOnly cookie and parses it back", () => {
    const header = buildPlayerCookieHeader("game-slug", "a.b", NOW + 1000, true);
    expect(header).toContain(`${playerCookieName("game-slug")}=a.b`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(readCookieValue(`other=1; ${header}`, playerCookieName("game-slug"))).toBe("a.b");
  });

  it("caps the roster so PIN guessing cannot mint endless players (PIN-43)", async () => {
    const { repository, deps } = await setup();
    for (let i = 0; i < 50; i++) {
      await repository.putPlayer({
        id: `p-${i}`,
        gameId: "game-slug",
        displayName: `P${i}`,
        cookieSecretHash: "h",
        posterOptIn: true,
        createdAt: NOW,
      });
    }
    await expect(joinGame("game-slug", { displayName: "Late" }, null, deps)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("fails closed when the session secret is missing or short", async () => {
    const { deps } = await setup();
    await expect(joinGame("game-slug", { displayName: "Robin" }, null, {
      ...deps,
      sessionSecret: "short",
    })).rejects.toMatchObject({ status: 503 });
  });
});
