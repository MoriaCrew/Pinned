import "server-only";
/**
 * Meta adapters for the capability ports (PIN-60). Thin outcome
 * mapping over MetaGateway transport — provider errors become
 * failed/refused outcomes; PIN-61 adds timeout/retry/budget/log
 * decorators around these.
 */
import type { MetaGateway } from "./meta-gateway";
import {
  buildSegmentPromptText,
  classifyPortError,
  type ElementNamer,
  type TapNamer,
  type SpeechTranscriber,
  type SceneComposer,
  type ChipSuggester,
  type Segmenter,
} from "./ports";

export function metaElementNamer(gateway: MetaGateway): ElementNamer {
  return {
    async nameElements(input) {
      try {
        const elements = await gateway.nameElements(input);
        return {
          status: "ready",
          value: { elements, promptVersion: input.promptVersion },
        };
      } catch (cause) {
        return classifyPortError(cause);
      }
    },
  };
}

export function metaTapNamer(gateway: MetaGateway): TapNamer {
  return {
    async nameOne(input) {
      try {
        const name = await gateway.nameOne(input);
        return {
          status: "ready",
          value: { name, promptVersion: input.promptVersion },
        };
      } catch (cause) {
        return classifyPortError(cause);
      }
    },
  };
}

export function metaSpeechTranscriber(gateway: MetaGateway): SpeechTranscriber {
  return {
    async transcribe(input) {
      try {
        const result = await gateway.transcribeAudio(input);
        if (!result.text) {
          return {
            status: "failed",
            errorCode: "no_speech",
            message: "No speech was heard in that clip.",
          };
        }
        return { status: "ready", value: result };
      } catch (cause) {
        return classifyPortError(cause);
      }
    },
  };
}

export function metaSegmenter(gateway: MetaGateway): Segmenter {
  return {
    async segment(input) {
      const promptText = buildSegmentPromptText(input.prompt);
      if (promptText.status !== "ready") return promptText;
      try {
        const { segments } = await gateway.segmentObject({
          imageRef: input.imageRef,
          concept:
            input.prompt.kind === "concept" ? input.prompt.concept : "",
          promptText: promptText.value,
          maskEncoding: input.maskEncoding,
          includeConfidence: input.includeConfidence,
          store: input.store,
          timeoutMs: input.timeoutMs,
        });
        return { status: "ready", value: { segments } };
      } catch (cause) {
        return classifyPortError(cause);
      }
    },
  };
}

export function metaChipSuggester(gateway: MetaGateway): ChipSuggester {
  return {
    async suggestChips(input) {
      try {
        const chips = await gateway.suggestChips(input);
        return {
          status: "ready",
          value: { chips, promptVersion: input.promptVersion },
        };
      } catch (cause) {
        return classifyPortError(cause);
      }
    },
  };
}

export function metaSceneComposer(gateway: MetaGateway): SceneComposer {
  return {
    async composeScene(input) {
      try {
        const outcome = await gateway.composeScene(input);
        if (outcome.status !== "ready") return outcome;
        return {
          status: "ready",
          value: {
            imageBase64: outcome.value.imageBase64,
            promptVersion: input.promptVersion,
          },
        };
      } catch (cause) {
        return classifyPortError(cause);
      }
    },
  };
}
