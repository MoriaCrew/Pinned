import "server-only";
import { getConfig } from "../config";
import { MetaGateway, type MetaGatewayOptions } from "./meta-gateway";
import { mockGateway } from "./mock-gateway";
import type { ModelGateway } from "./model-gateway";
import { metaChipSuggester, metaElementNamer, metaSceneComposer, metaSegmenter, metaSpeechTranscriber, metaTapNamer } from "./meta-ports";
import { mockChipSuggester, mockElementNamer, mockSceneComposer, mockSegmenter, mockSpeechTranscriber, mockTapNamer } from "./mock-ports";
import type { ChipSuggester, ElementNamer, SceneComposer, Segmenter, SpeechTranscriber, TapNamer } from "./ports";

// Entry points only. Types, ports, decorators and costs are imported
// from their own modules (./ports, ./decorators, ./costs, ...).

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
    voiceModel: cfg.meta.voiceModel,
    onLog: options.onLog,
  });
}

/**
 * Raw capability ports (docs/11 section 5.2): mock under AI_MOCK=1,
 * Meta otherwise. Product code should use the decorated ports from
 * src/server/ai-ports.ts (PIN-61); this stays for adapter-level
 * tests and composition.
 */
export function getCapabilityPorts(options: { onLog?: MetaGatewayOptions["onLog"] } = {}): { elementNamer: ElementNamer; segmenter: Segmenter; sceneComposer: SceneComposer; chipSuggester: ChipSuggester; tapNamer: TapNamer; speechTranscriber: SpeechTranscriber } {
  const cfg = getConfig();
  if (cfg.aiMock) {
    return {
      elementNamer: mockElementNamer,
      segmenter: mockSegmenter,
      sceneComposer: mockSceneComposer,
      chipSuggester: mockChipSuggester,
      tapNamer: mockTapNamer,
      speechTranscriber: mockSpeechTranscriber,
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
    voiceModel: cfg.meta.voiceModel,
    onLog: options.onLog,
  });
  return {
    elementNamer: metaElementNamer(gateway),
    segmenter: metaSegmenter(gateway),
    sceneComposer: metaSceneComposer(gateway),
    chipSuggester: metaChipSuggester(gateway),
    tapNamer: metaTapNamer(gateway),
    speechTranscriber: metaSpeechTranscriber(gateway),
  };
}
