import "server-only";
/**
 * Dictation service (PIN-119): one short WAV clip in, idea text
 * out, through the decorated SpeechTranscriber port. The clip is
 * validated here (RIFF/WAVE shape, mono 16-bit PCM at a Muse
 * Voice sample rate, Policy byte + seconds caps read from the
 * WAV header — never a client-declared duration) and lives only
 * in memory for the call: audio is never persisted, the same
 * stance as original photos (docs/11 A6). Every failure is a
 * typed BoardApiError with a friendly line, never a 500.
 */
import type { Participant } from "../domain/board";
import type { SpeechTranscriber } from "../gateway/ports";
import { t } from "../i18n";
import type { Policy } from "../policy/policy";
import { BoardApiError } from "./board-session";

export interface WavInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  durationSeconds: number;
}

/** Sample rates the Muse Voice file endpoint accepts. */
const VOICE_SAMPLE_RATES = new Set([16_000, 24_000]);

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

/**
 * Parse a canonical PCM WAV header. Returns null for anything
 * that is not a well-formed RIFF/WAVE with fmt + data chunks.
 * Duration comes from the data chunk size over the byte rate,
 * so a lying client cannot understate the clip length.
 */
export function parseWav(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 44) return null;
  if (tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number; byteRate: number } | null =
    null;
  let dataBytes: number | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      const audioFormat = view.getUint16(body, true);
      if (audioFormat !== 1) return null; // PCM only
      // Declared byteRate/blockAlign are client-controlled: they
      // must agree with the rate derived from the format fields,
      // or a clip could understate its duration (cap + reserve).
      const derivedAlign =
        (view.getUint16(body + 2, true) * view.getUint16(body + 14, true)) / 8;
      if (
        view.getUint16(body + 12, true) !== derivedAlign ||
        view.getUint32(body + 8, true) !== view.getUint32(body + 4, true) * derivedAlign
      ) {
        return null;
      }
      fmt = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 4, true) * ((view.getUint16(body + 2, true) * view.getUint16(body + 14, true)) / 8),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      // Claimed chunk size is client-controlled too: measure the
      // bytes actually present after the header (conservative).
      dataBytes = bytes.length - body;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || dataBytes === null || !(fmt.byteRate > 0)) return null;
  return {
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    durationSeconds: dataBytes / fmt.byteRate,
  };
}

export interface DictationDeps {
  transcriber?: SpeechTranscriber;
  policy: Policy;
}

/** Outcome messages the decorator already phrased for players. */
const FRIENDLY_CODES = new Set([
  "hourly_budget",
  "budget_off",
  "call_limit",
  "budget",
  "participant_cap",
  "board_cap",
  "timeout",
  "no_speech",
]);

/**
 * Transcribe one dictated clip for a joined participant. Throws
 * BoardApiError for every non-ready path (the route maps it);
 * the port outcome itself stays typed inside.
 */
export async function transcribeDictation(
  slug: string,
  viewer: Participant,
  clip: { bytes: Uint8Array; contentType: string },
  deps: DictationDeps,
): Promise<{ text: string }> {
  const { policy } = deps;
  if (!deps.transcriber) {
    throw new BoardApiError(t("en", "ai.failed"), 503, "no_transcriber");
  }
  if (clip.bytes.length === 0) {
    throw new BoardApiError(t("en", "dictate.badAudio"), 400, "empty_audio");
  }
  if (clip.bytes.length > policy.dictationMaxBytes) {
    throw new BoardApiError(t("en", "dictate.tooLong"), 413, "clip_too_large");
  }
  const wav = parseWav(clip.bytes);
  if (
    !wav ||
    wav.channels !== 1 ||
    wav.bitsPerSample !== 16 ||
    !VOICE_SAMPLE_RATES.has(wav.sampleRate)
  ) {
    throw new BoardApiError(t("en", "dictate.badAudio"), 415, "bad_audio");
  }
  if (wav.durationSeconds <= 0) {
    throw new BoardApiError(t("en", "dictate.noSpeech"), 400, "no_speech");
  }
  if (wav.durationSeconds > policy.dictationMaxSeconds) {
    throw new BoardApiError(t("en", "dictate.tooLong"), 400, "clip_too_long");
  }

  const outcome = await deps.transcriber.transcribe({
    audio: clip.bytes,
    durationSeconds: wav.durationSeconds,
    maxChars: policy.scenePromptMaxChars,
    timeoutMs: policy.timeoutsMs.voice,
    boardId: slug,
    participantId: viewer.id,
    userIdAtCall: viewer.userId ?? null,
  });
  if (outcome.status === "ready") {
    if (!outcome.value.text) {
      throw new BoardApiError(t("en", "dictate.noSpeech"), 400, "no_speech");
    }
    return { text: outcome.value.text };
  }
  if (outcome.status === "refused") {
    throw new BoardApiError(t("en", "dictate.noSpeech"), 400, "refused");
  }
  if (outcome.errorCode === "no_speech") {
    // A silent take is a normal outcome, like the empty-WAV and
    // empty-text paths above — never a service failure.
    throw new BoardApiError(t("en", "dictate.noSpeech"), 400, "no_speech");
  }
  const friendly =
    outcome.errorCode && FRIENDLY_CODES.has(outcome.errorCode)
      ? (outcome.message ?? t("en", "ai.failed"))
      : t("en", "ai.failed");
  // Budget denials are a friendly 429, never a 5xx (live-AI
  // budget contract); only genuine provider failures stay 503.
  const BUDGET_CODES = new Set([
    "hourly_budget",
    "participant_cap",
    "board_cap",
    "budget",
    "call_limit",
    "budget_off",
  ]);
  const status = outcome.errorCode && BUDGET_CODES.has(outcome.errorCode) ? 429 : 503;
  throw new BoardApiError(friendly, status, outcome.errorCode ?? "transcribe_failed");
}
