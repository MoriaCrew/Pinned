import "server-only";
import { getConfig } from "../config";
import { MetaGateway, type MetaGatewayOptions } from "./meta-gateway";
import { mockGateway } from "./mock-gateway";
import type { ModelGateway } from "./model-gateway";
import { metaChipSuggester, metaElementNamer, metaSceneComposer, metaSegmenter } from "./meta-ports";
import { mockChipSuggester, mockElementNamer, mockSceneComposer, mockSegmenter } from "./mock-ports";
import type { ChipSuggester, ElementNamer, SceneComposer, Segmenter } from "./ports";

export type { ModelGateway, ObjectLabel, SamSegment } from "./model-gateway";
export { MetaApiError, MetaGateway } from "./meta-gateway";
export type { MetaCallLog, MetaGatewayOptions } from "./meta-gateway";
export type {
  ComposeSceneInput,
  ElementNamer,
  NameElementsInput,
  NamedElement,
  PortOutcome,
  SceneComposer,
  Segmenter,
  SegmentInput,
  ChipSuggester,
  SuggestChipsInput,
  SegmentPrompt,
} from "./ports";
export {
  buildSceneResponsesBody,
  buildSegmentPromptText,
  classifyPortError,
  elementsSystemPrompt,
  normalizeElements,
  chipsSystemPrompt,
  normalizeChips,
  templateChips,
  sceneElementLabel,
  sceneImageOutcome,
  scenePromptText,
} from "./ports";
export type {
  ComposeSceneElement,
  SceneContentPart,
  SceneResponsesBody,
} from "./ports";
export {
  collectMetaCallLog,
  decoratePorts,
} from "./decorators";
export type { DecoratedPorts, PortDecoratorDeps } from "./decorators";
export {
  InMemoryBudgetStore,
  applyReserve,
  dayBucketFor,
  emptyBudgetDay,
  evaluateReserve,
} from "./budget";
export type {
  BudgetDayState,
  BudgetStore,
  ReserveDenyReason,
  ReserveRequest,
  ReserveResult,
} from "./budget";
export { estimateMetaCostUsd, estimateReserveUsd } from "./costs";
export type { PortOperation } from "./costs";
export { metaChipSuggester, metaElementNamer, metaSceneComposer, metaSegmenter } from "./meta-ports";
export { mockChipSuggester, mockElementNamer, mockSceneComposer, mockSegmenter } from "./mock-ports";
export { fixtureChipSuggester, fixtureElementNamer, fixtureSceneComposer, fixtureSegmenter } from "./fixture-ports";
export type { StudioFixtureElement, StudioFixtureScene, StudioFixtures } from "./fixture-ports";

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

/**
 * Raw capability ports (docs/11 section 5.2): mock under AI_MOCK=1,
 * Meta otherwise. Product code should use the decorated ports from
 * src/server/ai-ports.ts (PIN-61); this stays for adapter-level
 * tests and composition.
 */
export function getCapabilityPorts(options: { onLog?: MetaGatewayOptions["onLog"] } = {}): { elementNamer: ElementNamer; segmenter: Segmenter; sceneComposer: SceneComposer; chipSuggester: ChipSuggester } {
  const cfg = getConfig();
  if (cfg.aiMock) {
    return {
      elementNamer: mockElementNamer,
      segmenter: mockSegmenter,
      sceneComposer: mockSceneComposer,
      chipSuggester: mockChipSuggester,
    };
  }
  if (!cfg.meta.apiKey) {
    throw new Error("AI_MOCK=0 but META_API_KEY is not set. Set the key or AI_MOCK=1.");
  }
  const gateway = new MetaGateway({
    apiKey: cfg.meta.apiKey,
    baseUrl: cfg.meta.baseUrl,
    sparkModel: cfg.meta.sparkModel,
    samModel: cfg.meta.samModel,
    imageModel: cfg.meta.imageModel,
    onLog: options.onLog,
  });
  return {
    elementNamer: metaElementNamer(gateway),
    segmenter: metaSegmenter(gateway),
    sceneComposer: metaSceneComposer(gateway),
    chipSuggester: metaChipSuggester(gateway),
  };
}
