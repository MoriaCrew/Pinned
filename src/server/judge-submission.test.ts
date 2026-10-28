import { describe, expect, it } from "vitest";
import { InMemoryGameRepository } from "../domain/repository";
import type { Game, Submission } from "../domain/types";
import type { Judgement, ModelGateway } from "../gateway/model-gateway";
import { InMemoryDerivativeStore } from "./derivative-store";
import { GENERIC_TEASER, judgeSubmission } from "./judge-submission";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const SLUG = "game-slug";

function makeGame(): Game {
  return {
    id: SLUG,
    chainId: "chain-1",
    state: "OPEN",
    brief: "brief",
    challenge: "Find the most suspicious object on your desk.",
    persona: { name: "Greg from IT", language: "en", voiceRules: ["Deadpan."], catchphrases: [], judgingStyle: "Ticket log." },
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
    scores: null,
    reason: "",
    privateJudgement: "",
    teaser: "",
    safetyFlags: {},
    status: "active",
    judgeCount: 0,
    segmentCount: 0,
    submittedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function fakeGateway(result: Partial<Judgement>, counter: { calls: number }): ModelGateway {
  return {
    generatePersona: async () => { throw new Error("unused"); },
    segmentObject: async () => { throw new Error("unused"); },
    posterBackground: async () => { throw new Error("unused"); },
    writeDiary: async () => { throw new Error("unused"); },
    judgePhoto: async () => {
      counter.calls += 1;
      return {
        objectLabel: "rubber duck",
        altLabel: "A small desk toy",
        scores: { fit: 4, effort: 2, chaos: 5 },
        reason: "It is staring at the camera.",
        privateJudgement: "Ticket #7: suspicious. Approved.",
        teaser: "Something small has entered the chat.",
        safetyFlags: {},
        ...result,
      };
    },
  };
}

async function setup(result: Partial<Judgement> = {}) {
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
  const deps = { repository, store, gateway: fakeGateway(result, counter) };
  return { repository, store, deps, counter };
}

describe("judgeSubmission (PIN-44)", () => {
  it("judges once, persists rubric + teaser, and is idempotent", async () => {
    const { repository, deps, counter } = await setup();
    const first = await judgeSubmission(SLUG, "sub-1", deps);
    expect(first.outcome).toBe("judged");
    expect(first.submission.scores).toEqual({ fit: 4, effort: 2, chaos: 5 });
    expect(first.submission.objectLabel).toBe("rubber duck");
    expect(first.submission.judgeCount).toBe(1);
    const second = await judgeSubmission(SLUG, "sub-1", deps);
    expect(second.outcome).toBe("already");
    expect(counter.calls).toBe(1);
    const stored = (await repository.listSubmissions(SLUG))[0];
    expect(stored.privateJudgement).toContain("Ticket #7");
  });

  it("replaces a teaser that leaks the object or the player name", async () => {
    const a = await setup({ teaser: "Robin's rubber duck has arrived!" });
    const out = await judgeSubmission(SLUG, "sub-1", a.deps);
    expect(out.submission.teaser).toBe(GENERIC_TEASER);
  });

  it("aborts when the entry was superseded during the gateway call", async () => {
    const { repository, deps } = await setup();
    const inner = deps.gateway.judgePhoto.bind(deps.gateway);
    deps.gateway = {
      ...deps.gateway,
      judgePhoto: async (input) => {
        const current = (await repository.listSubmissions(SLUG))[0];
        await repository.putSubmission({ ...current, status: "superseded", supersededAt: NOW });
        return inner(input);
      },
    };
    await expect(judgeSubmission(SLUG, "sub-1", deps)).rejects.toMatchObject({ status: 409 });
    const stored = (await repository.listSubmissions(SLUG))[0];
    expect(stored.status).toBe("superseded");
    expect(stored.scores).toBeNull();
  });

  it("claims the attempt before calling, so failures still count toward the cap", async () => {
    const { repository, deps, counter } = await setup();
    deps.gateway = { ...deps.gateway, judgePhoto: async () => { counter.calls += 1; throw new Error("down"); } };
    await expect(judgeSubmission(SLUG, "sub-1", deps)).rejects.toThrow("down");
    const stored = (await repository.listSubmissions(SLUG))[0];
    expect(stored.judgeCount).toBe(1);
    expect(stored.scores).toBeNull();
    await expect(judgeSubmission(SLUG, "sub-1", deps)).rejects.toThrow("down");
    await expect(judgeSubmission(SLUG, "sub-1", deps)).rejects.toMatchObject({ status: 429 });
    expect(counter.calls).toBe(2);
  });
});
