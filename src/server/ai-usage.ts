import "server-only";
/**
 * AI usage accounting and daily guardrails (PIN-32).
 * Estimates use published Meta list prices; the provider dashboard
 * remains authoritative for billed amounts.
 *
 * PIN-61: pricing moved to src/gateway/costs.ts and the day bucket
 * to src/gateway/budget.ts (re-exported here for existing callers).
 * Studio traffic uses the decorated ports' atomic counter
 * (src/gateway/budget.ts). PIN-241: the operator SAM lab reserves
 * against that same atomic counter via reserveSamLabBudget below
 * (its raw ModelGateway shape cannot go through the decorated
 * ports); the scan-based summary remains for usage reporting only
 * and no longer gates any spend.
 */
import { randomUUID } from "node:crypto";
import type { GameRepository } from "../domain/repository";
import { aiCallCostUsdEst, isDeniedOutcome, type AiCallLog } from "../domain/types";
import { DEFAULT_POLICY, type Policy } from "../policy/policy";
import { dayBucketFor, type BudgetStore } from "../gateway/budget";
import { estimateMetaCostUsd, estimateReserveUsd } from "../gateway/costs";
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
/**
 * Atomic budget reserve for one SAM lab run (PIN-241). The lab
 * calls the raw ModelGateway (segmentObject, plus nameObject when
 * auto-labelling), whose shape the decorated capability ports do
 * not expose, so the route reserves here instead: one reserve per
 * provider call the run will make, priced with the same estimates
 * the decorator uses, against the same BudgetStore counter Studio
 * traffic uses. Both reserves land before any provider call, so a
 * denied or erroring reserve means no spend (fail closed) and
 * concurrent lab runs cannot race past the daily cap the way the
 * old scan-based pre-check could.
 */
export async function reserveSamLabBudget(
  budget: BudgetStore,
  policy: Pick<Policy, "dailyBudgetUsd" | "dailyCallLimit" | "maxTokens">,
  opts: { autoLabel: boolean },
  now: number = Date.now(),
): Promise<boolean> {
  const dayBucket = dayBucketFor(now);
  const reserveLimits = {
    sparkElementsMaxTokens: policy.maxTokens.sparkElements,
    sparkChipsMaxTokens: policy.maxTokens.sparkChips,
    sparkTapNameMaxTokens: policy.maxTokens.sparkTapName,
  };
  const operations = opts.autoLabel
    ? (["nameElements", "segment"] as const)
    : (["segment"] as const);
  try {
    for (const operation of operations) {
      const result = await budget.reserve({
        dayBucket,
        estimatedCostUsd: estimateReserveUsd(operation, reserveLimits),
        budgetUsd: policy.dailyBudgetUsd,
        callLimit: policy.dailyCallLimit,
      });
      if (!result.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}
