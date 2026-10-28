import { describe, expect, it } from "vitest";
import { InMemoryGameRepository } from "../domain/repository";
import type { Game, Submission } from "../domain/types";
import type { ModelGateway, ObjectLabel } from "../gateway/model-gateway";
import { InMemoryDerivativeStore } from "./derivative-store";
import { labelSubmission } from "./label-submission";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const SLUG = "game-slug";

function makeGame(): Game {
  return {
    id: SLUG,
    chainId: "chain-1",
    state: "OPEN",
    challenge: "Find the most suspicious object on your desk.",
    adminTokenHash: "hash",
    deadlineAt: NOW + 3_600_000,
    entryCount: 1,
    createdAt: NOW,
    version: 0,
  };
}

function makeSubmission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: "sub-1",
    gameId: SLUG,
    playerId: "player-1",
    workingRef: "tmp/games/game-slug/players/player-1/sub-1.webp",
    objectLabel: "",
    altLabel: "",
    safetyFlags: {},
    status: "active",
    labelCount: 0,
    segmentCount: 0,
    submittedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function fakeGateway(result: Partial<ObjectLabel>, counter: { calls: number }): ModelGateway {
  return {
    segmentObject: async () => { throw new Error("unused"); },
    nameObject: async () => {
      counter.calls += 1;
      return {
        objectLabel: "rubber duck",
        altLabel: "A small desk toy",
        safetyFlags: {},
        ...result,
      };
    },
  };
}

async function setup(result: Partial<ObjectLabel> = {}) {
  const repository = new InMemoryGameRepository();
  await repository.createChain({ id: "chain-1", gameCount: 1, createdAt: NOW });
  await repository.createGame(makeGame());
  await repository.putPlayer({
    id: "player-1", gameId: SLUG, displayName: "Robin", cookieSecretHash: "h", posterOptIn: true, createdAt: NOW,
  });
  const submission = makeSubmission();
  await repository.putSubmission(submission);
  const store = new InMemoryDerivativeStore();
  await store.put(submission.workingRef as string, new Uint8Array([1, 2, 3]), "image/webp");
  const counter = { calls: 0 };
  const deps = { repository, store, gateway: fakeGateway(result, counter), maxConceptWords: 3 };
  return { repository, store, deps, counter };
}

describe("labelSubmission (PIN-52)", () => {
  it("labels once, persists the object label, and is idempotent", async () => {
    const { repository, deps, counter } = await setup();
    const first = await labelSubmission(SLUG, "sub-1", deps);
    expect(first.outcome).toBe("labelled");
    expect(first.submission.objectLabel).toBe("rubber duck");
    expect(first.submission.labelCount).toBe(1);
    const second = await labelSubmission(SLUG, "sub-1", deps);
    expect(second.outcome).toBe("already");
    expect(counter.calls).toBe(1);
    const stored = (await repository.listSubmissions(SLUG))[0];
    expect(stored.altLabel).toBe("A small desk toy");
  });

  it("aborts when the entry was superseded during the gateway call", async () => {
    const { repository, deps } = await setup();
    const inner = deps.gateway.nameObject.bind(deps.gateway);
    deps.gateway = {
      ...deps.gateway,
      nameObject: async (input) => {
        const current = (await repository.listSubmissions(SLUG))[0];
        await repository.putSubmission({ ...current, status: "superseded", supersededAt: NOW });
        return inner(input);
      },
    };
    await expect(labelSubmission(SLUG, "sub-1", deps)).rejects.toMatchObject({ status: 409 });
    const stored = (await repository.listSubmissions(SLUG))[0];
    expect(stored.status).toBe("superseded");
    expect(stored.objectLabel).toBe("");
  });

  it("claims the attempt before calling, so failures still count toward the cap", async () => {
    const { repository, deps, counter } = await setup();
    deps.gateway = { ...deps.gateway, nameObject: async () => { counter.calls += 1; throw new Error("down"); } };
    await expect(labelSubmission(SLUG, "sub-1", deps)).rejects.toThrow("down");
    const stored = (await repository.listSubmissions(SLUG))[0];
    expect(stored.labelCount).toBe(1);
    expect(stored.objectLabel).toBe("");
    await expect(labelSubmission(SLUG, "sub-1", deps)).rejects.toThrow("down");
    await expect(labelSubmission(SLUG, "sub-1", deps)).rejects.toMatchObject({ status: 429 });
    expect(counter.calls).toBe(2);
  });
});
