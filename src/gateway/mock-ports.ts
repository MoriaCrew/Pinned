import "server-only";
/**
 * Mock adapters for the capability ports (PIN-60), used under
 * AI_MOCK=1. Deterministic, offline, and free of any user-visible
 * "(mock)" strings (docs/11 section 5.2).
 */
import { mockGateway } from "./mock-gateway";
import {
  buildSceneResponsesBody,
  buildSegmentPromptText,
  normalizeElements,
  type ElementNamer,
  type NamedElement,
  type SceneComposer,
  type ChipSuggester,
  templateChips,
  type Segmenter,
} from "./ports";

const MOCK_ELEMENTS: NamedElement[] = [
  {
    label: "Teal Mug",
    concept: "teal mug",
    description: "distressed turquoise glaze with worn white base",
    faceFlag: false,
  },
  {
    label: "Rubber Duck",
    concept: "rubber duck",
    description: "small yellow duck wearing black sunglasses",
    faceFlag: false,
  },
  {
    label: "Potted Succulent",
    concept: "potted succulent",
    description: "green rosette succulent in speckled white pot",
    faceFlag: false,
  },
];

export const mockElementNamer: ElementNamer = {
  async nameElements(input) {
    return {
      status: "ready",
      value: {
        elements: normalizeElements(MOCK_ELEMENTS, input),
        promptVersion: input.promptVersion,
      },
    };
  },
};

export const mockSegmenter: Segmenter = {
  async segment(input) {
    const promptText = buildSegmentPromptText(input.prompt);
    if (promptText.status !== "ready") return promptText;
    const { segments } = await mockGateway.segmentObject({
      imageRef: input.imageRef,
      concept: promptText.value,
    });
    return { status: "ready", value: { segments } };
  },
};

/** Deterministic 1x1 PNG returned as the composed scene (PIN-68). */
export const MOCK_SCENE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";

export const mockChipSuggester: ChipSuggester = {
  async suggestChips(input) {
    return {
      status: "ready",
      value: {
        chips: templateChips(input.labels, input),
        promptVersion: input.promptVersion,
      },
    };
  },
};

export const mockSceneComposer: SceneComposer = {
  async composeScene(input) {
    // Same validation as the Meta builder (model id is a dummy here:
    // the mock never sends the body anywhere).
    const built = buildSceneResponsesBody(input, "mock-image");
    if (built.status !== "ready") return built;
    return {
      status: "ready",
      value: {
        imageBase64: MOCK_SCENE_PNG_BASE64,
        promptVersion: input.promptVersion,
      },
    };
  },
};
