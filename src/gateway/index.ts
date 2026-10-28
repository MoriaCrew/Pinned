import "server-only";
import { getConfig } from "../config";
import { MetaGateway, type MetaGatewayOptions } from "./meta-gateway";
import { mockGateway } from "./mock-gateway";
import type { ModelGateway } from "./model-gateway";

export type { DiaryEntry, HostPersona, Judgement, ModelGateway, RubricScores, SamSegment } from "./model-gateway";
export { MetaApiError, MetaGateway } from "./meta-gateway";
export type { MetaCallLog, MetaGatewayOptions } from "./meta-gateway";

/**
 * Mock stays the default (AI_MOCK=1). Live mode requires a Meta key
 * and fails loud without one — never silently falls back.
 */
export function getModelGateway(options: { onLog?: MetaGatewayOptions["onLog"] } = {}): ModelGateway {
  const cfg = getConfig();
  if (cfg.aiMock) return mockGateway;
  if (!cfg.meta.apiKey) {
    throw new Error("AI_MOCK=0 but META_API_KEY is not set. Set the key or AI_MOCK=1.");
  }
  return new MetaGateway({
    apiKey: cfg.meta.apiKey,
    baseUrl: cfg.meta.baseUrl,
    sparkModel: cfg.meta.sparkModel,
    samModel: cfg.meta.samModel,
    imageModel: cfg.meta.imageModel,
    onLog: options.onLog,
  });
}
