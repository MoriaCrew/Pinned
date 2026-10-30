import { describe, expect, it } from "vitest";
import { InMemoryGameRepository } from "./repository";
import type { AiCallLog } from "./types";

function makeLog(overrides: Partial<AiCallLog> = {}): AiCallLog {
  return {
    id: "l1",
    operation: "nameObject",
    model: "m",
    latencyMs: 5,
    outcome: "ok",
    dayBucket: "2026-10-26",
    createdAt: 0,
    ...overrides,
  };
}

describe("InMemoryGameRepository (AI call logs, PIN-93)", () => {
  it("stores day-bucketed AI logs and filters by bucket", async () => {
    const repo = new InMemoryGameRepository();
    await repo.appendAiCallLog(makeLog());
    await repo.appendAiCallLog(makeLog({ id: "l2", dayBucket: "2026-10-27" }));
    expect(await repo.listAiCallLogs("2026-10-26")).toHaveLength(1);
    expect(await repo.listAiCallLogs("2026-10-27")).toHaveLength(1);
    expect(await repo.listAiCallLogs("2026-10-28")).toHaveLength(0);
  });

  it("returns isolated copies so callers cannot mutate stored logs", async () => {
    const repo = new InMemoryGameRepository();
    const log = makeLog();
    await repo.appendAiCallLog(log);
    log.outcome = "error";
    const read = await repo.listAiCallLogs("2026-10-26");
    expect(read[0].outcome).toBe("ok");
    read[0].outcome = "refused";
    expect((await repo.listAiCallLogs("2026-10-26"))[0].outcome).toBe("ok");
  });
});
