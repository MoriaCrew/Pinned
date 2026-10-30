/**
 * AI cost rollups for `npm run usage:costs` (PIN-137). Pure:
 * groups AiCallLog rows per board / participant / operation over
 * a day range. Board ids are slugs (capability secrets) and are
 * NEVER returned raw — callers hash them for display via
 * `boardHash` (injected so this module stays crypto-free).
 * All money figures are integer micro-USD ESTIMATES.
 */
import { aiCallCostUsdEst, normalizeAiCallLog, type AiCallLog } from "./types";

export interface UsageCostRow {
  /** Hashed board id (never the raw slug); "unknown" pre-v2. */
  board: string;
  participantId: string;
  operation: string;
  calls: number;
  denied: number;
  reservedMicroUsd: number;
  costMicroUsdEst: number;
}

export interface UsageCostsSummary {
  fromDay: string;
  toDay: string;
  rows: UsageCostRow[];
  totalCalls: number;
  totalDenied: number;
  totalCostMicroUsdEst: number;
  /** Always true: figures are list-price estimates. */
  estimates: true;
}

export function summarizeUsageCosts(
  logs: readonly AiCallLog[],
  range: { fromDay: string; toDay: string },
  boardHash: (boardId: string) => string,
): UsageCostsSummary {
  const byKey = new Map<string, UsageCostRow>();
  let totalCalls = 0;
  let totalDenied = 0;
  let totalCostMicroUsdEst = 0;
  for (const raw of logs) {
    const log = normalizeAiCallLog(raw);
    if (log.dayBucket < range.fromDay || log.dayBucket > range.toDay) continue;
    const board = log.boardId ? boardHash(log.boardId) : "unknown";
    const participantId = log.participantId ?? "unknown";
    const key = `${board} ${participantId} ${log.operation}`;
    const row = byKey.get(key) ?? {
      board,
      participantId,
      operation: log.operation,
      calls: 0,
      denied: 0,
      reservedMicroUsd: 0,
      costMicroUsdEst: 0,
    };
    const denied = log.outcome.startsWith("denied_");
    row.calls += 1;
    if (denied) row.denied += 1;
    row.reservedMicroUsd += log.reservedMicroUsd ?? 0;
    const costMicro = Math.round(aiCallCostUsdEst(log) * 1_000_000);
    row.costMicroUsdEst += costMicro;
    byKey.set(key, row);
    totalCalls += 1;
    if (denied) totalDenied += 1;
    totalCostMicroUsdEst += costMicro;
  }
  const rows = [...byKey.values()].sort(
    (a, b) =>
      b.costMicroUsdEst - a.costMicroUsdEst ||
      a.board.localeCompare(b.board) ||
      a.participantId.localeCompare(b.participantId) ||
      a.operation.localeCompare(b.operation),
  );
  return {
    fromDay: range.fromDay,
    toDay: range.toDay,
    rows,
    totalCalls,
    totalDenied,
    totalCostMicroUsdEst,
    estimates: true,
  };
}

/** "$0.0123 (estimate)" style label — estimates stay labelled. */
export function formatMicroUsdEst(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)} (estimate)`;
}
