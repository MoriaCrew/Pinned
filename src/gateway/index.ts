import { getConfig } from "../config";
import { mockGateway } from "./mock-gateway";
import type { ModelGateway } from "./model-gateway";

export type { DiaryEntry, HostPersona, Judgement, ModelGateway, RubricScores } from "./model-gateway";

/** Live Meta Model API gateway lands in PIN-3. Fails loud, never silently. */
export function getModelGateway(): ModelGateway {
  if (getConfig().aiMock) return mockGateway;
  throw new Error("Live ModelGateway not implemented yet (PIN-3). Set AI_MOCK=1.");
}
