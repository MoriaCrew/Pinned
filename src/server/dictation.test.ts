import { describe, expect, it } from "vitest";
import type { Participant } from "../domain/board";
import { encodeWavPcm16 } from "../app/g/[slug]/dictate-audio";
import type { SpeechTranscriber, TranscribeInput } from "../gateway/ports";
import { resolvePolicy } from "../policy/policy";
import { BoardApiError } from "./board-session";
import { parseWav, transcribeDictation } from "./dictation";

const viewer = { id: "p1", boardId: "b1" } as Participant;
const SLUG = "b1";

function wav(seconds: number, sampleRate = 16_000): Uint8Array {
  return encodeWavPcm16(new Float32Array(Math.round(seconds * sampleRate)), sampleRate);
}

function okTranscriber(calls: TranscribeInput[]): SpeechTranscriber {
  return {
    async transcribe(input) {
      calls.push(input);
      return { status: "ready", value: { text: "floating in space" } };
    },
  };
}

async function expectBoardError(run: Promise<unknown>, status: number, code: string) {
  await expect(run).rejects.toMatchObject({ status, code });
  await expect(run.catch((e: unknown) => e)).resolves.toBeInstanceOf(BoardApiError);
}

describe("parseWav (PIN-119)", () => {
  it("reads channels, rate, bits and duration from the header", () => {
    expect(parseWav(wav(2.5))).toEqual({
      channels: 1,
      sampleRate: 16_000,
      bitsPerSample: 16,
      durationSeconds: 2.5,
    });
  });

  it("rejects non-WAV and truncated bytes", () => {
    expect(parseWav(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseWav(new TextEncoder().encode("not a wav file at all, nope nope nope"))).toBeNull();
  });
});

describe("transcribeDictation gates (PIN-119)", () => {
  const policy = resolvePolicy();

  it("transcribes a valid clip with the header-derived duration", async () => {
    const calls: TranscribeInput[] = [];
    const out = await transcribeDictation(
      SLUG,
      viewer,
      { bytes: wav(2), contentType: "audio/wav" },
      { transcriber: okTranscriber(calls), policy },
    );
    expect(out).toEqual({ text: "floating in space" });
    expect(calls[0]).toMatchObject({
      durationSeconds: 2,
      maxChars: policy.scenePromptMaxChars,
      timeoutMs: policy.timeoutsMs.voice,
      boardId: SLUG,
      participantId: "p1",
    });
  });

  it("rejects empty, oversized, non-WAV and wrong-format clips before any call", async () => {
    const calls: TranscribeInput[] = [];
    const deps = { transcriber: okTranscriber(calls), policy };
    await expectBoardError(
      transcribeDictation(SLUG, viewer, { bytes: new Uint8Array(), contentType: "audio/wav" }, deps),
      400,
      "empty_audio",
    );
    await expectBoardError(
      transcribeDictation(
        SLUG,
        viewer,
        { bytes: new Uint8Array(policy.dictationMaxBytes + 1), contentType: "audio/wav" },
        deps,
      ),
      413,
      "clip_too_large",
    );
    await expectBoardError(
      transcribeDictation(
        SLUG,
        viewer,
        { bytes: new TextEncoder().encode("x".repeat(100)), contentType: "audio/webm" },
        deps,
      ),
      415,
      "bad_audio",
    );
    // 8kHz WAV is well-formed but not a Muse Voice sample rate.
    await expectBoardError(
      transcribeDictation(SLUG, viewer, { bytes: wav(1, 8_000), contentType: "audio/wav" }, deps),
      415,
      "bad_audio",
    );
    expect(calls).toHaveLength(0);
  });

  it("enforces the Policy seconds cap from the WAV header, not the client", async () => {
    const calls: TranscribeInput[] = [];
    const short = resolvePolicy({ dictationMaxSeconds: 5 });
    await expectBoardError(
      transcribeDictation(
        SLUG,
        viewer,
        { bytes: wav(6), contentType: "audio/wav" },
        { transcriber: okTranscriber(calls), policy: short },
      ),
      400,
      "clip_too_long",
    );
    expect(calls).toHaveLength(0);
  });

  it("maps port outcomes to typed friendly errors", async () => {
    const clip = { bytes: wav(1), contentType: "audio/wav" };
    const refused: SpeechTranscriber = {
      async transcribe() {
        return { status: "refused", errorCode: "content_policy" };
      },
    };
    await expectBoardError(
      transcribeDictation(SLUG, viewer, clip, { transcriber: refused, policy }),
      400,
      "refused",
    );

    const capped: SpeechTranscriber = {
      async transcribe() {
        return {
          status: "failed",
          errorCode: "participant_cap",
          message: "You've reached today's limit. Try again tomorrow.",
        };
      },
    };
    const capErr = await transcribeDictation(SLUG, viewer, clip, {
      transcriber: capped,
      policy,
    }).catch((e: unknown) => e);
    expect(capErr).toBeInstanceOf(BoardApiError);
    expect(capErr).toMatchObject({ status: 429, code: "participant_cap" });
    expect((capErr as Error).message).toContain("today's limit");

    const providerBoom: SpeechTranscriber = {
      async transcribe() {
        return { status: "failed", errorCode: "http_500", message: "raw provider detail" };
      },
    };
    const boomErr = await transcribeDictation(SLUG, viewer, clip, {
      transcriber: providerBoom,
      policy,
    }).catch((e: unknown) => e);
    expect(boomErr).toMatchObject({ status: 503 });
    expect((boomErr as Error).message).not.toContain("raw provider detail");
  });

  it("fails closed without a transcriber", async () => {
    await expectBoardError(
      transcribeDictation(SLUG, viewer, { bytes: wav(1), contentType: "audio/wav" }, { policy }),
      503,
      "no_transcriber",
    );
  });
});
