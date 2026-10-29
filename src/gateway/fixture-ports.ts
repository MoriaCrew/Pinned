import "server-only";
/**
 * Recorded-fixture adapters for the capability ports (PIN-60).
 * Replay the PIN-50 studio fixtures (eval/fixtures/studio/
 * fixtures.json) with zero provider calls, so contract tests and
 * offline previews see exactly what the spike recorded.
 *
 * fixtures.json records each element's SAM box + confidence but not
 * the mask raster, so the fixture Segmenter returns the recorded box
 * with a deterministic placeholder mask at the box size.
 */
import type { SamSegment } from "./model-gateway";
import {
  buildSceneResponsesBody,
  buildSegmentPromptText,
  normalizeElements,
  type ElementNamer,
  type SceneComposer,
  type ChipSuggester,
  templateChips,
  type Segmenter,
} from "./ports";

export interface StudioFixtureElement {
  id: string;
  photoId: string;
  label: string;
  concept: string;
  description: string;
  faceFlag: boolean;
  box?: { x1: number; y1: number; x2: number; y2: number };
  confidence?: number;
}

export interface StudioFixtureScene {
  id: string;
  mode: string;
  size: string;
  prompt: string;
  elementIds: string[];
  outcome: string;
}

export interface StudioFixtures {
  elements: StudioFixtureElement[];
  scenes?: StudioFixtureScene[];
}

export function fixtureElementNamer(fixtures: StudioFixtures): ElementNamer {
  return {
    async nameElements(input) {
      const photoId =
        input.fixturePhotoId ?? fixtures.elements[0]?.photoId;
      const rows = fixtures.elements.filter((e) => e.photoId === photoId);
      if (!rows.length) {
        return {
          status: "failed",
          errorCode: "fixture_not_found",
          message: `No recorded elements for photo ${photoId ?? "(none)"}.`,
        };
      }
      return {
        status: "ready",
        value: {
          elements: normalizeElements(rows, input),
          promptVersion: input.promptVersion,
        },
      };
    },
  };
}

export function fixtureSegmenter(fixtures: StudioFixtures): Segmenter {
  return {
    async segment(input) {
      const promptText = buildSegmentPromptText(input.prompt);
      if (promptText.status !== "ready") return promptText;
      if (input.prompt.kind !== "concept") {
        return {
          status: "failed",
          errorCode: "fixture_concept_only",
          message: "Recorded fixtures only cover concept prompts.",
        };
      }
      const concept = input.prompt.concept.trim().toLowerCase();
      const matches = fixtures.elements.filter(
        (e) => e.concept.toLowerCase() === concept && e.box,
      );
      const segments: SamSegment[] = matches.map((e, i) => {
        const box = e.box as { x1: number; y1: number; x2: number; y2: number };
        const w = Math.max(1, box.x2 - box.x1 + 1);
        const h = Math.max(1, box.y2 - box.y1 + 1);
        return {
          id: String(i),
          box: {
            ...box,
            w,
            h,
            ...(e.confidence !== undefined
              ? { confidence: e.confidence }
              : {}),
          },
          mask: { height: h, width: w, encoding: "~", payload: "fixture" },
        };
      });
      return { status: "ready", value: { segments } };
    },
  };
}

/**
 * Replay a recorded PIN-50 scene (PIN-68). fixtures.json stores the
 * scene metadata (mode, prompt, elementIds, outcome); the composed
 * JPEG itself lives at eval/fixtures/studio/scenes/{id}.jpg, so the
 * outcome carries it as imageRef instead of inline base64. PIN-50
 * recorded no raw /v1/responses body; the wire-level replay fixture
 * is eval/fixtures/studio/compose-response.fixture.json.
 */
/**
 * No chips were recorded by PIN-50, so the fixture suggester
 * replays the deterministic template chips: same labels in, same
 * chips out, zero provider calls (PIN-75).
 */
export function fixtureChipSuggester(): ChipSuggester {
  return {
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
}

export function fixtureSceneComposer(fixtures: StudioFixtures): SceneComposer {
  return {
    async composeScene(input) {
      const built = buildSceneResponsesBody(input, "fixture-image");
      if (built.status !== "ready") return built;
      const scenes = fixtures.scenes ?? [];
      const scene = input.fixtureSceneId
        ? scenes.find((s) => s.id === input.fixtureSceneId)
        : (scenes.find((s) => s.mode === "flattened" && s.outcome === "ok") ??
          scenes[0]);
      if (!scene) {
        return {
          status: "failed",
          errorCode: "fixture_not_found",
          message: `No recorded scene ${input.fixtureSceneId ?? "(default)"}.`,
        };
      }
      if (scene.outcome === "refused") {
        return {
          status: "refused",
          errorCode: "no_image",
          message: "The image model returned no image for this prompt.",
        };
      }
      if (scene.outcome !== "ok") {
        return {
          status: "failed",
          errorCode: "fixture_outcome",
          message: `Recorded scene ${scene.id} outcome was ${scene.outcome}.`,
        };
      }
      return {
        status: "ready",
        value: {
          imageRef: `eval/fixtures/studio/scenes/${scene.id}.jpg`,
          promptVersion: input.promptVersion,
        },
      };
    },
  };
}
