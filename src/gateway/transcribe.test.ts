import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AiCallLog } from "../domain/types";
import { DEFAULT_POLICY, resolvePolicy } from "../policy/policy";
import { InMemoryBudgetStore, dayBucketFor } from "./budget";
import {
  VOICE_USD_PER_AUDIO_SECOND,
  estimateMetaCostUsd,
  estimateReserveUsd,
} from "./costs";
import { decoratePorts } from "./decorators";
import { fixtureSpeechTranscriber, type StudioFixtures } from "./fixture-ports";
import { MetaGateway } from "./meta-gateway";
import { metaSpeechTranscriber } from "./meta-ports";
import { MOCK_TRANSCRIPT, mockElementNamer, mockSegmenter, mockSpeechTranscriber } from "./mock-ports";
import { normalizeTranscript, type TranscribeInput } from "./ports";

const fixtures = JSON.parse(
  readFileSync(path.join(process.cwd(), "eval/fixtures/studio/fixtures.json"), "utf8"),
) as StudioFixtures;

function transcribeInput(over: Partial<TranscribeInput> = {}): TranscribeInput {
  const p = DEFAULT_POLICY;
  return {
    audio: new Uint8Array([1, 2, 3]),
    durationSeconds: 2.5,
    maxChars: p.scenePromptMaxChars,
    timeoutMs: p.timeoutsMs.voice,
    ...over,
  };
}

describe("normalizeTranscript (PIN-119)", () => {
  it("reads the PUSH_TO_TALK top-level transcript and joins turns", () => {
    expect(
      normalizeTranscript({ transcript: "  a tiny\n picnic  ", turns: [] }, 500),
    ).toBe("a tiny picnic");
    expect(
      normalizeTranscript(
        { turns: [{ transcript: "floating" }, { transcript: "in space" }] },
        500,
      ),
    ).toBe("floating in space");
  });

  it("caps at the idea-field limit and returns empty for junk", () => {
    expect(normalizeTranscript({ transcript: "abcdefghij" }, 4)).toBe("abcd");
    expect(normalizeTranscript({}, 500)).toBe("");
    expect(normalizeTranscript("nope", 500)).toBe("");
    expect(normalizeTranscript(null, 500)).toBe("");
  });
});

describe("voice pricing (PIN-119)", () => {
  it("prices whole audio-seconds at the $3/1000-minute list rate", () => {
    expect(VOICE_USD_PER_AUDIO_SECOND).toBeCloseTo(0.00005, 10);
    expect(
      estimateMetaCostUsd({
        operation: "transcribeAudio",
        model: "muse-voice-transcribe-1.0",
        latencyMs: 1,
        outcome: "ok",
        audioSeconds: 2.48,
      }),
    ).toBeCloseTo(3 * VOICE_USD_PER_AUDIO_SECOND, 12);
    expect(
      estimateMetaCostUsd({
        operation: "transcribeAudio",
        model: "muse-voice-transcribe-1.0",
        latencyMs: 1,
        outcome: "error",
        audioSeconds: 2.48,
      }),
    ).toBe(0);
  });

  it("reserves the clip's own seconds, else the Policy cap", () => {
    const limits = { sparkElementsMaxTokens: 4000, voiceMaxSeconds: 30 };
    expect(estimateReserveUsd("transcribe", { ...limits, voiceSeconds: 2.1 })).toBeCloseTo(
      3 * VOICE_USD_PER_AUDIO_SECOND,
      12,
    );
    expect(estimateReserveUsd("transcribe", limits)).toBeCloseTo(
      30 * VOICE_USD_PER_AUDIO_SECOND,
      12,
    );
  });
});

describe("transcribe adapters (PIN-119)", () => {
  it("mock returns the stable synthetic idea, no mock marker", async () => {
    const out = await mockSpeechTranscriber.transcribe(transcribeInput());
    expect(out).toEqual({
      status: "ready",
      value: { text: MOCK_TRANSCRIPT, audioDurationMs: 2500 },
    });
    expect(JSON.stringify(out)).not.toContain("(mock)");
  });

  it("fixture replays the first recorded scene prompt", async () => {
    const out = await fixtureSpeechTranscriber(fixtures).transcribe(transcribeInput());
    expect(out.status).toBe("ready");
    if (out.status !== "ready") return;
    const scene = fixtures.scenes?.find((s) => s.outcome === "ok");
    expect(out.value.text).toBe(scene?.prompt);
  });

  it("meta posts cookbook multipart (JSON request part + WAV audio part)", async () => {
    const seen: { url: string; auth: string | null; form: FormData }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        form: init?.body as FormData,
      });
      return new Response(
        JSON.stringify({
          sessionId: "s1",
          transcript: "A tiny picnic on the lawn.",
          audioDurationMs: 2480,
          turns: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const gateway = new MetaGateway({
      apiKey: "test-key",
      baseUrl: "https://api.meta.ai/v1",
      sparkModel: DEFAULT_POLICY.models.spark,
      samModel: DEFAULT_POLICY.models.sam,
      imageModel: DEFAULT_POLICY.models.image,
      voiceModel: DEFAULT_POLICY.models.voice,
      fetchFn,
    });
    const out = await metaSpeechTranscriber(gateway).transcribe(transcribeInput());
    expect(out).toEqual({
      status: "ready",
      value: { text: "A tiny picnic on the lawn.", audioDurationMs: 2480 },
    });
    expect(seen[0].url).toBe("https://api.meta.ai/v1/asr/transcribe");
    expect(seen[0].auth).toBe("Bearer test-key");
    const requestPart = seen[0].form.get("request") as Blob;
    expect(JSON.parse(await requestPart.text())).toEqual({
      mode: "PUSH_TO_TALK",
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
    });
    const audioPart = seen[0].form.get("audio") as File;
    expect(audioPart.name).toBe("clip.wav");
    expect(audioPart.type).toBe("audio/wav");
  });

  it("meta maps a silent clip to no_speech and HTTP errors to failed, never a throw", async () => {
    const silent = new MetaGateway({
      apiKey: "test-key",
      baseUrl: "https://api.meta.ai/v1",
      sparkModel: "s",
      samModel: "s",
      imageModel: "s",
      fetchFn: (async () =>
        new Response(JSON.stringify({ transcript: "", turns: [] }), {
          status: 200,
        })) as typeof fetch,
    });
    expect(await metaSpeechTranscriber(silent).transcribe(transcribeInput())).toMatchObject({
      status: "failed",
      errorCode: "no_speech",
    });

    const denied = new MetaGateway({
      apiKey: "test-key",
      baseUrl: "https://api.meta.ai/v1",
      sparkModel: "s",
      samModel: "s",
      imageModel: "s",
      fetchFn: (async () =>
        new Response(
          JSON.stringify({ error: { code: "invalid_api_key", message: "no" } }),
          { status: 401 },
        )) as typeof fetch,
    });
    const out = await metaSpeechTranscriber(denied).transcribe(transcribeInput());
    expect(out).toMatchObject({ status: "failed", errorCode: "invalid_api_key", httpStatus: 401 });
  });
});

describe("decorated SpeechTranscriber (PIN-119)", () => {
  const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

  function decorated(policy = resolvePolicy()) {
    const budget = new InMemoryBudgetStore();
    const logs: AiCallLog[] = [];
    let calls = 0;
    const base = {
      async transcribe() {
        calls += 1;
        return {
          status: "ready" as const,
          value: { text: "floating in space", audioDurationMs: 2000 },
        };
      },
    };
    const ports = decoratePorts(
      { elementNamer: mockElementNamer, segmenter: mockSegmenter, speechTranscriber: base },
      {
        policy,
        budget,
        appendLog: async (log) => {
          logs.push(log);
        },
        now: () => NOW,
        sleep: async () => undefined,
        newId: () => "log-1",
        onLogError: () => undefined,
      },
    );
    return { ports, budget, logs, calls: () => calls };
  }

  it("reserves under participantTranscriptions and cost-logs transcribe", async () => {
    const { ports, budget, logs } = decorated();
    const out = await ports.speechTranscriber!.transcribe(
      transcribeInput({ participantId: "p1", boardId: "b1" }),
    );
    expect(out.status).toBe("ready");
    const snap = budget.snapshot(dayBucketFor(NOW));
    expect(snap.participantTranscriptions).toEqual({ p1: 1 });
    expect(snap.participants).toEqual({});
    // Reserve priced the clip's own 2.5s at whole seconds.
    expect(snap.reservedMicroUsd).toBe(Math.round(3 * VOICE_USD_PER_AUDIO_SECOND * 1_000_000));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      operation: "transcribe",
      model: "muse-voice-transcribe-1.0",
      outcome: "ok",
    });
  });

  it("denies at the Policy dictation cap before any provider call", async () => {
    const { ports, calls } = decorated(resolvePolicy({ dictationsPerParticipantPerDay: 1 }));
    const input = transcribeInput({ participantId: "p1" });
    expect((await ports.speechTranscriber!.transcribe(input)).status).toBe("ready");
    const denied = await ports.speechTranscriber!.transcribe(input);
    expect(denied).toMatchObject({ status: "failed", errorCode: "participant_cap" });
    expect(calls()).toBe(1);
  });
});
