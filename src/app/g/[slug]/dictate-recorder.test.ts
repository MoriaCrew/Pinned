import { describe, expect, it, vi } from "vitest";
import { startRecorder, stopStream } from "./dictate-recorder";

// PIN-232: the mic light must go off when the recorder cannot be built or
// started. There is no DOM here, so the recorder and stream are plain fakes.
function fakeStream(tracks = 2) {
  const stops = Array.from({ length: tracks }, () => vi.fn());
  const stream = { getTracks: () => stops.map((stop) => ({ stop })) } as unknown as MediaStream;
  return { stream, stops };
}

function fakeRecorder(start: () => void = () => {}) {
  return { start: vi.fn(start), state: "inactive" } as unknown as MediaRecorder & { start: ReturnType<typeof vi.fn> };
}

describe("startRecorder", () => {
  it("attaches the handlers, then starts, and leaves the mic on", () => {
    const { stream, stops } = fakeStream();
    const recorder = fakeRecorder();
    const order: string[] = [];
    recorder.start.mockImplementation(() => order.push("start"));
    const result = startRecorder(
      stream,
      () => order.push("attach"),
      () => recorder,
    );
    expect(result).toBe(recorder);
    expect(order).toEqual(["attach", "start"]);
    for (const stop of stops) expect(stop).not.toHaveBeenCalled();
  });

  it("stops every track and returns null when the recorder cannot be built", () => {
    const { stream, stops } = fakeStream(3);
    const attach = vi.fn();
    const result = startRecorder(stream, attach, () => {
      throw new Error("NotSupportedError");
    });
    expect(result).toBeNull();
    expect(attach).not.toHaveBeenCalled();
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops every track and returns null when start() throws", () => {
    const { stream, stops } = fakeStream();
    const recorder = fakeRecorder(() => {
      throw new Error("InvalidStateError");
    });
    const result = startRecorder(
      stream,
      () => {},
      () => recorder,
    );
    expect(result).toBeNull();
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
  });

  it("releases the mic when attaching a handler throws", () => {
    const { stream, stops } = fakeStream();
    const result = startRecorder(
      stream,
      () => {
        throw new Error("boom");
      },
      () => fakeRecorder(),
    );
    expect(result).toBeNull();
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("stopStream", () => {
  it("stops the remaining tracks even when one refuses", () => {
    const first = vi.fn(() => {
      throw new Error("already gone");
    });
    const second = vi.fn();
    const stream = { getTracks: () => [{ stop: first }, { stop: second }] } as unknown as MediaStream;
    expect(() => stopStream(stream)).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
