import "server-only";
/**
 * Mock adapters for the capability ports (PIN-60), used under
 * AI_MOCK=1. Deterministic, offline, and free of any user-visible
 * "(mock)" strings (docs/11 section 5.2).
 */
import { mockGateway } from "./mock-gateway";
import {
  buildSegmentPromptText,
  normalizeElements,
  type ElementNamer,
  type NamedElement,
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
