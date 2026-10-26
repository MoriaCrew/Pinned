/**
 * ModelGateway — the ONLY door to AI providers (docs/02 §3).
 * UI/domain code never imports a provider SDK. Live Meta implementation
 * lands with PIN-3; until then the mock is the default everywhere.
 */

export interface HostPersona {
  name: string;
  language: string; // BCP 47, from the creator brief (FR9.3)
  voiceRules: string[];
  catchphrases: string[];
  judgingStyle: string;
}

export interface RubricScores {
  fit: number; // 0-5
  effort: number; // 0-5
  chaos: number; // 0-5
}

export interface Judgement {
  objectLabel: string; // plain nouns, feeds SAM concept prompt
  altLabel: string; // accessibility alt text (PIN-21 a11y verdict)
  scores: RubricScores;
  reason: string;
  privateJudgement: string; // prose only; numeric scores stay hidden pre-close
  teaser: string; // anonymous; must not leak name/object
  safetyFlags: { screens?: boolean; documents?: boolean; faces?: boolean };
}

export interface DiaryEntry {
  winner: string;
  superlatives: string[];
  runningJokes: string[];
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
  generatePersona(brief: string): Promise<{ persona: HostPersona; challenge: string }>;
  judgePhoto(input: { imageRef: string; challenge: string }): Promise<Judgement>;
  segmentObject(input: { imageRef: string; concept: string }): Promise<{ segments: SamSegment[] }>;
  posterBackground(input: { challenge: string }): Promise<{ imageRef: string }>;
  writeDiary(input: { winner: string }): Promise<DiaryEntry>;
}
