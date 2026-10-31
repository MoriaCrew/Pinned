/**
 * Client dictation audio helpers (PIN-119). The Muse Voice file
 * endpoint takes mono 16-bit PCM WAV only, while MediaRecorder
 * yields webm/mp4 — so the recorded blob is decoded with Web
 * Audio, resampled offline to 16kHz mono, and encoded here into
 * the canonical 44-byte-header WAV the server validates.
 */
export const DICTATION_SAMPLE_RATE = 16_000;

/** Encode mono float samples (-1..1) as 16-bit PCM WAV bytes. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeTag = (offset: number, tag: string) => {
    for (let i = 0; i < tag.length; i += 1) view.setUint8(offset + i, tag.charCodeAt(i));
  };
  writeTag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeTag(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * bytesPerSample, Math.round(clamped * 0x7fff), true);
  }
  return new Uint8Array(buffer);
}

/**
 * Decode a recorded blob and resample it to mono 16kHz WAV.
 * Browser-only (Web Audio); throws when decode fails so the
 * caller can show the friendly dictation failure line.
 */
export async function blobToDictationWav(blob: Blob, maxSeconds?: number): Promise<Uint8Array> {
  const decodeContext = new AudioContext();
  try {
    const decoded = await decodeContext.decodeAudioData(await blob.arrayBuffer());
    // Cap the frame count at the Policy clip limit so the
    // header-derived duration can never land a frame over it.
    const capFrames =
      maxSeconds !== undefined
        ? Math.max(1, Math.floor(maxSeconds * DICTATION_SAMPLE_RATE))
        : Number.POSITIVE_INFINITY;
    const frames = Math.min(
      Math.max(1, Math.ceil(decoded.duration * DICTATION_SAMPLE_RATE)),
      capFrames,
    );
    const offline = new OfflineAudioContext(1, frames, DICTATION_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWavPcm16(rendered.getChannelData(0), DICTATION_SAMPLE_RATE);
  } finally {
    await decodeContext.close().catch(() => undefined);
  }
}
