import { describe, expect, it } from "vitest";
import { mockGateway } from "./mock-gateway";

describe("mockGateway", () => {
  it("generates a persona and challenge from a one-line brief", async () => {
    const out = await mockGateway.generatePersona("a dramatic sports commentator");
    expect(out.persona.name.length).toBeGreaterThan(0);
    expect(out.challenge.length).toBeGreaterThan(0);
  });

  it("gives distinct personas for the three sample briefs", async () => {
    const briefs = [
      "a passive-aggressive IT helpdesk",
      "a dramatic sports commentator",
      "my unimpressed grandmother",
    ];
    const results = await Promise.all(briefs.map((brief) => mockGateway.generatePersona(brief)));
    expect(new Set(results.map((result) => result.persona.name)).size).toBe(3);
    expect(new Set(results.map((result) => result.challenge)).size).toBe(3);
    for (const result of results) {
      expect(result.persona.voiceRules.join(" ")).toMatch(/never the person/i);
    }
  });

  it("judges with in-range rubric scores", async () => {
    const j = await mockGateway.judgePhoto({ imageRef: "x", challenge: "y" });
    for (const v of Object.values(j.scores)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(5);
    }
    expect(j.objectLabel.length).toBeGreaterThan(0);
  });
});
