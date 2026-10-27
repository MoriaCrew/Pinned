import type { HostPersona, ModelGateway } from "./model-gateway";

function mockPersona(brief: string): { persona: HostPersona; challenge: string } {
  const text = brief.toLowerCase();
  const commonRule = "Roast the photo, effort and timing — never the person.";

  if (/(helpdesk|help desk|\bit\b|sysadmin|ticket)/.test(text)) {
    return {
      persona: {
        name: "Marj from IT (mock)",
        language: "en",
        voiceRules: ["Open like an incident ticket.", "Be dry, brisk and specific.", commonRule],
        catchphrases: ["INCIDENT LOGGED.", "Have you tried caring?"],
        judgingStyle: "Ticket-style verdicts tied strictly to the rubric.",
      },
      challenge: "Find the most suspicious object on your desk.",
    };
  }

  if (/(sport|commentator|commentary|football|match)/.test(text)) {
    return {
      persona: {
        name: "Big Voice Barry (mock)",
        language: "en",
        voiceRules: ["Call every entry like a cup final.", "Build drama without inventing facts.", commonRule],
        catchphrases: ["UNBELIEVABLE SCENES!", "The crowd is on its feet!"],
        judgingStyle: "Maximum drama, rubric always decides the result.",
      },
      challenge: "Find the object in your home most ready for championship glory.",
    };
  }

  if (/(grandmother|grandma|nana|granny)/.test(text)) {
    return {
      persona: {
        name: "Nana (mock)",
        language: "en",
        voiceRules: ["Sound caring, unimpressed and impossible to fool.", "Compare effort with basic household standards.", commonRule],
        catchphrases: ["Bless your heart.", "I expected better, dear."],
        judgingStyle: "Warmly devastating, with rubric-first fairness.",
      },
      challenge: "Find the household object with the most suspicious story behind it.",
    };
  }

  return {
    persona: {
      name: "The Unimpressed Host (mock)",
      language: "en",
      voiceRules: [`Channels: ${brief.slice(0, 80)}`, commonRule],
      catchphrases: ["Noted. Barely."],
      judgingStyle: "Dry, rubric-first, one-liners.",
    },
    challenge: "Find the most suspicious object on your desk.",
  };
}

/** Deterministic gateway for CI, previews and offline dev (AI_MOCK=1). */
export const mockGateway: ModelGateway = {
  async generatePersona(brief) {
    return mockPersona(brief);
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
