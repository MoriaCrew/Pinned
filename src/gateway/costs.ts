import "server-only";
/**
 * Meta list-price cost estimates (moved from src/server/ai-usage in
 * PIN-61 so the gateway decorator chain can price reservations and
 * AiCallLog rows without importing the server layer). Estimates
 * only; the provider dashboard remains authoritative.
 */
import type { MetaCallLog } from "./meta-gateway";

export const SPARK_INPUT_USD_PER_TOKEN = 1.25 / 1_000_000;
export const SPARK_OUTPUT_USD_PER_TOKEN = 4.25 / 1_000_000;
export const SAM_USD_PER_IMAGE = 2.5 / 1_000;

export function estimateMetaCostUsd(entry: MetaCallLog): number {
  if (entry.outcome !== "ok") return 0;
  if (entry.operation === "segmentObject") return SAM_USD_PER_IMAGE * (entry.images ?? 1);
  return (
    (entry.inputTokens ?? 0) * SPARK_INPUT_USD_PER_TOKEN +
    (entry.outputTokens ?? 0) * SPARK_OUTPUT_USD_PER_TOKEN
  );
}

export type PortOperation = "nameElements" | "segment" | "composeScene";

/**
 * Conservative pre-call reserve estimate: Spark is priced at its
 * full Policy output-token budget, SAM bills exactly one image per
 * concept call (PIN-50), and a scene reuses the Spark token proxy
 * until /responses prices are published (eval/studio-findings T5).
 */
export function estimateReserveUsd(
  operation: PortOperation,
  limits: { sparkElementsMaxTokens: number },
): number {
  if (operation === "segment") return SAM_USD_PER_IMAGE;
  return limits.sparkElementsMaxTokens * SPARK_OUTPUT_USD_PER_TOKEN;
}
