import { describe, expect, it } from "vitest";
import { InMemoryGameRepository } from "../domain/repository";
import {
  createMetaLogSink,
  estimateMetaCostUsd,
  getTodayAiUsage,
  isAiBudgetExhausted,
} from "./ai-usage";

describe("AI usage guardrails", () => {
  it("estimates Spark, SAM, and Muse Image list-price costs", () => {
    expect(estimateMetaCostUsd({
      operation: "judgePhoto",
      model: "muse-spark-1.3",
      latencyMs: 1,
      outcome: "ok",
      inputTokens: 2_414,
      outputTokens: 1_954,
    })).toBeCloseTo(0.011322, 6);
    expect(estimateMetaCostUsd({
      operation: "segmentObject",
      model: "sam-3.1",
      latencyMs: 1,
      outcome: "ok",
      images: 1,
    })).toBe(0.0025);
    expect(estimateMetaCostUsd({
      operation: "posterBackground",
      model: "muse-image-1.0",
      latencyMs: 1,
      outcome: "error",
      images: 1,
    })).toBe(0);
  });

  it("persists costed logs and detects either daily ceiling", async () => {
    const repository = new InMemoryGameRepository();
    const now = Date.UTC(2026, 9, 27, 12, 0, 0);
    const sink = createMetaLogSink(repository, () => now);
    await sink({
      operation: "generatePersona",
      model: "muse-spark-1.3",
      latencyMs: 10,
      outcome: "ok",
      inputTokens: 164,
      outputTokens: 1_717,
    });
    const usage = await getTodayAiUsage(repository, now);
    expect(usage.dayBucket).toBe("2026-10-27");
    expect(usage.callCount).toBe(1);
    expect(usage.estimatedCostUsd).toBeCloseTo(0.007502, 6);
    expect(await repository.listAiCallLogs("2026-10-27")).toMatchObject([
      { promptVersion: "persona.v1", outcome: "ok" },
    ]);
    expect(isAiBudgetExhausted(usage, { aiDailyBudgetUsd: 0.007, aiDailyCallLimit: 200 })).toBe(true);
    expect(isAiBudgetExhausted(usage, { aiDailyBudgetUsd: 2, aiDailyCallLimit: 1 })).toBe(true);
    expect(isAiBudgetExhausted(usage, { aiDailyBudgetUsd: 2, aiDailyCallLimit: 200 })).toBe(false);
  });
});
