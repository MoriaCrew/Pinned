import "server-only";
/**
 * AI usage accounting and daily guardrails (PIN-32).
 * Estimates use published Meta list prices; the provider dashboard
 * remains authoritative for billed amounts.
 */
import { randomUUID } from "node:crypto";
import type { GameRepository } from "../domain/repository";
import type { AiCallLog } from "../domain/types";
import type { MetaCallLog } from "../gateway/meta-gateway";

const SPARK_INPUT_USD_PER_TOKEN = 1.25 / 1_000_000;
const SPARK_OUTPUT_USD_PER_TOKEN = 4.25 / 1_000_000;
const SAM_USD_PER_IMAGE = 2.5 / 1_000;

export function estimateMetaCostUsd(entry: MetaCallLog): number {
  if (entry.outcome !== "ok") return 0;
  if (entry.operation === "segmentObject") return SAM_USD_PER_IMAGE * (entry.images ?? 1);
  return (
    (entry.inputTokens ?? 0) * SPARK_INPUT_USD_PER_TOKEN +
    (entry.outputTokens ?? 0) * SPARK_OUTPUT_USD_PER_TOKEN
  );
}

export function dayBucketFor(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface AiUsageSummary {
  dayBucket: string;
  callCount: number;
  estimatedCostUsd: number;
}

export function summarizeAiUsage(logs: readonly AiCallLog[], dayBucket: string): AiUsageSummary {
  return {
    dayBucket,
    callCount: logs.length,
    estimatedCostUsd: logs.reduce((sum, log) => sum + (log.costEstimateUsd ?? 0), 0),
  };
}

export function isAiBudgetExhausted(
  summary: AiUsageSummary,
  limits: { aiDailyBudgetUsd: number; aiDailyCallLimit: number },
): boolean {
  return summary.estimatedCostUsd >= limits.aiDailyBudgetUsd ||
    summary.callCount >= limits.aiDailyCallLimit;
}

export async function getTodayAiUsage(
  repository: GameRepository,
  now = Date.now(),
): Promise<AiUsageSummary> {
  const dayBucket = dayBucketFor(now);
  return summarizeAiUsage(await repository.listAiCallLogs(dayBucket), dayBucket);
}

export function createMetaLogSink(
  repository: GameRepository,
  now: () => number = Date.now,
): (entry: MetaCallLog) => Promise<void> {
  return async (entry) => {
    const createdAt = now();
    await repository.appendAiCallLog({
      id: randomUUID(),
      operation: entry.operation,
      model: entry.model,
      promptVersion: entry.operation === "nameObject" ? "label.v1" : undefined,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      images: entry.images,
      latencyMs: entry.latencyMs,
      costEstimateUsd: estimateMetaCostUsd(entry),
      outcome: entry.outcome,
      dayBucket: dayBucketFor(createdAt),
      createdAt,
    });
  };
}
