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
/**
 * Muse Image list price (PIN-180): a flat $0.01 per generated image,
 * whatever the token counts. Tokens stay on the log row for
 * attribution but never move the price.
 */
export const MUSE_IMAGE_USD_PER_IMAGE = 0.01;
/** Muse Voice Transcribe list price (PIN-119): $3 per 1,000 audio-minutes. */
export const VOICE_USD_PER_AUDIO_SECOND = 3 / 1_000 / 60;

export function estimateMetaCostUsd(entry: MetaCallLog): number {
  if (entry.outcome !== "ok") return 0;
  if (entry.operation === "segmentObject") return SAM_USD_PER_IMAGE * (entry.images ?? 1);
  if (entry.operation === "composeScene") {
    // The gateway counts the images a reply really holds, so a reply
    // with no image (a refusal) is free; a row without the count is
    // an ok call and is priced as one image.
    return MUSE_IMAGE_USD_PER_IMAGE * (entry.images ?? 1);
  }
  if (entry.operation === "transcribeAudio") {
    // Billed per whole audio-second (PIN-119).
    return Math.ceil(entry.audioSeconds ?? 0) * VOICE_USD_PER_AUDIO_SECOND;
  }
  return (
    (entry.inputTokens ?? 0) * SPARK_INPUT_USD_PER_TOKEN +
    (entry.outputTokens ?? 0) * SPARK_OUTPUT_USD_PER_TOKEN
  );
}

/** USD -> integer micro-USD (PIN-137). Estimates only. */
export function usdToMicroUsd(usd: number): number {
  return Math.max(0, Math.round(usd * 1_000_000));
}

export type PortOperation =
  | "nameElements"
  | "segment"
  | "composeScene"
  | "suggestChips"
  | "nameOne"
  | "transcribe";

/**
 * Conservative pre-call reserve estimate: Spark is priced at its
 * full Policy output-token budget, SAM bills exactly one image per
 * concept call (PIN-50), and a scene is the flat Muse Image price
 * for the one image it asks for (PIN-180).
 */
export function estimateReserveUsd(
  operation: PortOperation,
  limits: { sparkElementsMaxTokens: number; sparkChipsMaxTokens?: number; sparkTapNameMaxTokens?: number; voiceMaxSeconds?: number; voiceSeconds?: number },
): number {
  if (operation === "segment") return SAM_USD_PER_IMAGE;
  if (operation === "composeScene") return MUSE_IMAGE_USD_PER_IMAGE;
  if (operation === "suggestChips") {
    // PIN-75: priced at the small chips token budget, not elements.
    return (limits.sparkChipsMaxTokens ?? limits.sparkElementsMaxTokens) * SPARK_OUTPUT_USD_PER_TOKEN;
  }
  if (operation === "nameOne") {
    // PIN-117: priced at the small tap-name token budget.
    return (limits.sparkTapNameMaxTokens ?? limits.sparkElementsMaxTokens) * SPARK_OUTPUT_USD_PER_TOKEN;
  }
  if (operation === "transcribe") {
    // PIN-119: reserve the clip's own whole seconds when known,
    // else the full Policy clip cap.
    const seconds = limits.voiceSeconds ?? limits.voiceMaxSeconds ?? 0;
    return Math.ceil(seconds) * VOICE_USD_PER_AUDIO_SECOND;
  }
  return limits.sparkElementsMaxTokens * SPARK_OUTPUT_USD_PER_TOKEN;
}

export function estimateReserveMicroUsd(
  operation: PortOperation,
  limits: Parameters<typeof estimateReserveUsd>[1],
): number {
  return usdToMicroUsd(estimateReserveUsd(operation, limits));
}
