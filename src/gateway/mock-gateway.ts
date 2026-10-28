import "server-only";
import type { ModelGateway } from "./model-gateway";

/** Deterministic gateway for CI, previews and offline dev (AI_MOCK=1). */
export const mockGateway: ModelGateway = {
  async nameObject() {
    return {
      objectLabel: "desk object",
      altLabel: "A cut-out of the submitted object",
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
};
