import type { ModelGateway } from "./model-gateway";

/** Deterministic gateway for CI, previews and offline dev (AI_MOCK=1). */
export const mockGateway: ModelGateway = {
  async generatePersona(brief) {
    return {
      persona: {
        name: "The Unimpressed Host (mock)",
        language: "en",
        voiceRules: [`Channels: ${brief.slice(0, 80)}`, "Roast the photo, never the person."],
        catchphrases: ["Noted. Barely."],
        judgingStyle: "Dry, rubric-first, one-liners.",
      },
      challenge: "Find the most suspicious object on your desk.",
    };
  },
  async judgePhoto() {
    return {
      objectLabel: "desk object",
      altLabel: "A cut-out of the submitted object",
      scores: { fit: 3, effort: 3, chaos: 3 },
      reason: "Mock judgement (AI_MOCK=1).",
      privateJudgement: "Mock host: a bold choice. Scores at reveal.",
      teaser: "Someone has entered the arena…",
      safetyFlags: {},
    };
  },
  async segmentObject({ imageRef }) {
    void imageRef;
    return {
      segments: [
        {
          id: "0",
          box: { x1: 0, y1: 0, x2: 10, y2: 10, w: 100, h: 100 },
          mask: { height: 10, width: 10, encoding: "~", payload: "mock" },
        },
      ],
    };
  },
  async posterBackground() {
    return { imageRef: "mock://poster-background" };
  },
  async writeDiary({ winner }) {
    return { winner, superlatives: ["Mock champion"], runningJokes: ["The desk incident"] };
  },
};
