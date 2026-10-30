import "server-only";
/**
 * AI usage accounting and daily guardrails (PIN-32).
 * Estimates use published Meta list prices; the provider dashboard
 * remains authoritative for billed amounts.
 *
 * PIN-61: pricing moved to src/gateway/costs.ts and the day bucket
 * to src/gateway/budget.ts (re-exported here for existing callers).
 * The scan-based guard below now serves only the operator SAM lab
 * (PIN-93 deleted the legacy ModelGateway routes); Studio traffic
 * uses the decorated ports' atomic counter (src/gateway/budget.ts).
 */
import { randomUUID } from "node:crypto";
import type { GameRepository } from "../domain/repository";
import { aiCallCostUsdEst, isDeniedOutcome, type AiCallLog } from "../domain/types";
import { DEFAULT_POLICY } from "../policy/policy";
import { dayBucketFor } from "../gateway/budget";
import { estimateMetaCostUsd } from "../gateway/costs";
import type { MetaCallLog } from "../gateway/meta-gateway";

export { dayBucketFor, estimateMetaCostUsd };

export interface AiUsageSummary {
  dayBucket: string;
  /** Provider calls only: denied_* rows (PIN-137) never reached a
   *  provider, so they must not consume the lab call limit. */
  callCount: number;
  deniedCount: number;
  estimatedCostUsd: number;
}

export function summarizeAiUsage(logs: readonly AiCallLog[], dayBucket: string): AiUsageSummary {
  const deniedCount = logs.filter((log) => isDeniedOutcome(log.outcome)).length;
  return {
    dayBucket,
    callCount: logs.length - deniedCount,
    deniedCount,
    estimatedCostUsd: logs.reduce((sum, log) => sum + aiCallCostUsdEst(log), 0),
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
  // PIN-137: retention comes from Policy at the call site; the
  // default keeps existing callers on the Policy default.
  retentionDays: number = DEFAULT_POLICY.aiCallLogRetentionDays,
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
      costMicroUsdEst: Math.max(0, Math.round(estimateMetaCostUsd(entry) * 1_000_000)),
      schemaVersion: 2,
      userIdAtCall: null,
      attempt: 0,
      attempts: 1,
      outcome: entry.outcome,
      dayBucket: dayBucketFor(createdAt),
      createdAt,
      expireAt: createdAt + retentionDays * 86_400_000,
    });
  };
}
