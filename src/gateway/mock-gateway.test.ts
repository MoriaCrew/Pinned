import { describe, expect, it } from "vitest";
import { mockGateway } from "./mock-gateway";

describe("mockGateway", () => {
  it("names an object for the SAM concept prompt", async () => {
    const out = await mockGateway.nameObject({ imageRef: "x", maxConceptWords: 3 });
    expect(out.objectLabel.length).toBeGreaterThan(0);
    expect(out.altLabel.length).toBeGreaterThan(0);
  });

  it("returns a parseable mock segment", async () => {
    const out = await mockGateway.segmentObject({ imageRef: "x", concept: "desk object" });
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].mask.height).toBeGreaterThan(0);
  });
});
