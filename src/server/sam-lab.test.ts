import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { mockGateway } from "../gateway/mock-gateway";
import type { ModelGateway } from "../gateway/model-gateway";
import { SamLabError, parseSamLabInput, runSamLab } from "./sam-lab";

async function makePhoto(width = 320, height = 334): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 80, b: 40 } },
  })
    .jpeg()
    .toBuffer();
}

describe("parseSamLabInput", () => {
  it("validates modes, fractions, and required prompts", () => {
    expect(() => parseSamLabInput({ mode: "nope" })).toThrow(SamLabError);
    expect(() => parseSamLabInput({ mode: "concept" })).toThrow(/Name the object/);
    expect(() => parseSamLabInput({ mode: "points", points: "[]" })).toThrow(/Tap/);
    expect(() =>
      parseSamLabInput({ mode: "points", points: JSON.stringify([{ x: 2, y: 0.5 }]) }),
    ).toThrow(/fractions/);
    expect(parseSamLabInput({ mode: "concept", concept: " red mug " }).concept).toBe("red mug");
  });
});

describe("runSamLab", () => {
  it("mock mode returns a labelled synthetic segment with renders", async () => {
    const result = await runSamLab(
      await makePhoto(),
      { mode: "concept", concept: "mug" },
      { gateway: mockGateway, mock: true },
    );
    expect(result.mock).toBe(true);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].coverageFramePct).toBeGreaterThan(5);
    expect(result.segments[0].cutoutPng.startsWith("data:image/png;base64,")).toBe(true);
    expect(result.overlayJpeg.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(result.image.width).toBe(320);
  });

  it("live-shape gateway segments decode and render end to end", async () => {
    let seenPrompt: string | undefined;
    const gateway: ModelGateway = {
      ...mockGateway,
      async segmentObject(input) {
        seenPrompt = input.promptText;
        return {
          segments: [
            {
              id: "0",
              box: { x1: 211, y1: 228, x2: 270, y2: 254, w: 320, h: 334 },
              mask: {
                height: 27,
                width: 60,
                encoding: "~",
                payload: "!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(",
              },
            },
          ],
        };
      },
    };
    const result = await runSamLab(
      await makePhoto(),
      {
        mode: "points",
        points: [{ x: 0.75, y: 0.72, label: "positive" }],
      },
      { gateway, mock: false },
    );
    expect(seenPrompt).toContain("<|point;x=240;y=240;w=320;h=334|>");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].maskPixels).toBeGreaterThan(100);
    expect(result.segments[0].box).toEqual({ x1: 211, y1: 228, x2: 270, y2: 254 });
  });

  it("auto-label uses the judge objectLabel as the concept", async () => {
    let concept = "";
    const gateway: ModelGateway = {
      ...mockGateway,
      async judgePhoto() {
        return {
          objectLabel: "brass lamp",
          altLabel: "A brass lamp",
          scores: { fit: 3, effort: 3, chaos: 3 },
          reason: "",
          privateJudgement: "",
          teaser: "",
          safetyFlags: {},
        };
      },
      async segmentObject(input) {
        concept = input.concept;
        return { segments: [] };
      },
    };
    const result = await runSamLab(
      await makePhoto(),
      { mode: "concept", autoLabel: true },
      { gateway, mock: false },
    );
    expect(concept).toBe("brass lamp");
    expect(result.judge?.objectLabel).toBe("brass lamp");
    expect(result.segments).toHaveLength(0);
  });
});
