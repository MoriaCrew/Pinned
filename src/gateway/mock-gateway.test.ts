import { describe, expect, it } from "vitest";
import { mockGateway } from "./mock-gateway";

describe("mockGateway", () => {
  it("generates a persona and challenge from a one-line brief", async () => {
    const out = await mockGateway.generatePersona("a dramatic sports commentator");
    expect(out.persona.name.length).toBeGreaterThan(0);
    expect(out.challenge.length).toBeGreaterThan(0);
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
