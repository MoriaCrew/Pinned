/**
 * ModelGateway — the ONLY door to AI providers. UI/domain code
 * never imports a provider SDK. The Studio capability ports
 * (docs/11 §5.2) reshape this in PIN-60; until then it carries
 * the two surviving calls: name the main object, segment it.
 */

/** Main-object label for one photo (prompts/label.v1.md). */
export interface ObjectLabel {
  objectLabel: string; // plain noun phrase, feeds the SAM concept prompt
  altLabel: string; // accessibility alt text
  safetyFlags: { screens?: boolean; documents?: boolean; faces?: boolean };
}

/** One SAM 3.1 match: box in frame pixels + encoded mask raster.
 *  Mask payload is base85 (Meta docs sam/reading-segmentation);
 *  decoding to a PNG cut-out is compositing, not gateway work. */
export interface SamSegment {
  id: string;
  box: { x1: number; y1: number; x2: number; y2: number; w: number; h: number; confidence?: number };
  mask: { height: number; width: number; encoding: string; payload: string };
}

export interface ModelGateway {
  nameObject(input: {
    imageRef: string;
    /** Policy conceptMaxWords; callers pass the resolved Policy value. */
    maxConceptWords: number;
  }): Promise<ObjectLabel>;
  segmentObject(input: {
    imageRef: string;
    /** Short noun phrase, one concept (ignored when promptText is set). */
    concept: string;
    /** Raw object-prompt text (box/point tokens) for tap reselect. */
    promptText?: string;
    maskEncoding?: "lossless" | "one_bit";
    includeConfidence?: boolean;
    /** Policy samStore (PIN-213): omitted from the body when undefined. */
    store?: boolean;
  }): Promise<{ segments: SamSegment[] }>;
}
