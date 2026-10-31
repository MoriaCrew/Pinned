import "server-only";
import type { ModelGateway } from "./model-gateway";

/**
 * Deterministic synthetic SAM mask (PIN-65): a 200x200 one-bit
 * raster with a centred blob (~20k px), encoded once with the
 * @meta-sam/parser conformance encoder. Unlike the old placeholder
 * payload it actually decodes, so the AI_MOCK=1 decompose path
 * yields usable candidate pins end-to-end.
 */
const MOCK_MASK_PAYLOAD =
  "!!!#8(ikw!9mYf![.)GhA@&0vqT2'5e=PZLEYZ[38oiG7Yf&BS`R7uK*W3I)d+htdAb34K@y7yjX2_{*Zz'qN#H_o:qmzq#5jsZtEreMfeikYKHwVk+eNF0'R1-)=h:dOKr4Zkg!!!";

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
          box: { x1: 0, y1: 0, x2: 199, y2: 199, w: 200, h: 200 },
          mask: { height: 200, width: 200, encoding: "!", payload: MOCK_MASK_PAYLOAD },
        },
      ],
    };
  },
};
