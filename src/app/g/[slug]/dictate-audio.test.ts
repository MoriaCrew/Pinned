import { describe, expect, it } from "vitest";
import { parseWav } from "../../../server/dictation";
import { DICTATION_SAMPLE_RATE, encodeWavPcm16 } from "./dictate-audio";

describe("encodeWavPcm16 (PIN-119)", () => {
  it("writes a canonical mono 16-bit WAV the server parses back", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
    const bytes = encodeWavPcm16(samples, DICTATION_SAMPLE_RATE);
    expect(bytes.length).toBe(44 + samples.length * 2);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Out-of-range samples clamp instead of wrapping.
    expect(view.getInt16(44 + 3 * 2, true)).toBe(0x7fff);
    expect(view.getInt16(44 + 4 * 2, true)).toBe(-0x7fff);
    expect(view.getInt16(44 + 5 * 2, true)).toBe(0x7fff);
    expect(parseWav(bytes)).toMatchObject({
      channels: 1,
      sampleRate: 16_000,
      bitsPerSample: 16,
    });
  });

  it("duration round-trips through the server header parse", () => {
    const bytes = encodeWavPcm16(new Float32Array(16_000 * 3), DICTATION_SAMPLE_RATE);
    expect(parseWav(bytes)?.durationSeconds).toBe(3);
  });
});
