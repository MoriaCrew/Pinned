"use client";

import { useEffect, useRef, useState } from "react";
import { clipClock } from "../../../domain/make-sheet";
import { t, tf } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import { blobToDictationWav } from "./dictate-audio";

export type DictateState = "idle" | "recording" | "working";

/**
 * Dictation for the Make-sheet idea (PIN-119; a hook since PIN-216 so
 * the mic can live inside the field): MediaRecorder captures a short
 * clip, the clip is re-encoded to mono 16kHz WAV, the board transcribe
 * route runs it through the decorated Muse Voice port, and the
 * transcript goes to `onText`. `supported` is false without a mic +
 * MediaRecorder (the caller hides the mic); `elapsed` counts whole
 * seconds up to the Policy clip cap; failures are friendly lines.
 */
export function useDictation({
  slug,
  maxSeconds,
  onText,
}: {
  slug: string;
  /** Policy dictationMaxSeconds: recording auto-stops there. */
  maxSeconds: number;
  onText: (transcript: string) => void;
}) {
  const locale = useLocale();
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<DictateState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<{ recorder: MediaRecorder; stream: MediaStream; timer: number; clock: number } | null>(
    null,
  );
  // Unmount + double-start guard: a getUserMedia promise can
  // resolve after the sheet closed; only a live owner may keep
  // the stream, otherwise the mic would stay on with no owner.
  const liveRef = useRef(true);
  const startingRef = useRef(false);

  useEffect(() => {
    liveRef.current = true;
    setSupported(
      typeof window !== "undefined" &&
        typeof window.MediaRecorder !== "undefined" &&
        Boolean(navigator.mediaDevices?.getUserMedia),
    );
    return () => {
      liveRef.current = false;
      stopSession();
    };
  }, []);

  function stopSession() {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return;
    window.clearTimeout(session.timer);
    window.clearInterval(session.clock);
    if (session.recorder.state === "recording") {
      // Detach first so teardown can never trigger an upload.
      session.recorder.onstop = null;
      try {
        session.recorder.stop();
      } catch {
        // Already stopping; tracks are killed below regardless.
      }
    }
    session.stream.getTracks().forEach((track) => track.stop());
  }

  async function upload(blob: Blob) {
    setState("working");
    try {
      const wav = await blobToDictationWav(blob, maxSeconds);
      const form = new FormData();
      form.append("audio", new Blob([wav as BlobPart], { type: "audio/wav" }), "clip.wav");
      const response = await fetch(`/api/boards/${slug}/transcribe`, {
        method: "POST",
        body: form,
      });
      const data = (await response.json().catch(() => null)) as
        | { text?: unknown; error?: unknown }
        | null;
      if (!response.ok || typeof data?.text !== "string" || !data.text) {
        setError(typeof data?.error === "string" ? data.error : t(locale, "make.dictateFailed"));
        return;
      }
      onText(data.text);
    } catch {
      setError(t(locale, "make.dictateFailed"));
    } finally {
      setState("idle");
    }
  }

  async function start() {
    if (startingRef.current || sessionRef.current) return;
    startingRef.current = true;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      startingRef.current = false;
      if (liveRef.current) setError(t(locale, "make.dictateNoMic"));
      return;
    }
    startingRef.current = false;
    // Sheet closed while the permission prompt was up: kill the
    // stream instead of recording with no owner.
    if (!liveRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const wasLive = liveRef.current;
      stopSession();
      if (wasLive) {
        void upload(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      }
    };
    // Stop a beat early: MediaRecorder framing can run a little
    // past the timer, and the WAV conversion also caps frames.
    const timer = window.setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, Math.max(300, maxSeconds * 1000 - 300));
    const startedAt = Date.now();
    const clock = window.setInterval(() => {
      setElapsed(Math.min(maxSeconds, Math.round((Date.now() - startedAt) / 1000)));
    }, 1000);
    sessionRef.current = { recorder, stream, timer, clock };
    setElapsed(0);
    recorder.start();
    setState("recording");
  }

  function stop() {
    if (sessionRef.current?.recorder.state === "recording") {
      sessionRef.current.recorder.stop();
    }
  }

  return { supported, state, elapsed, error, start: () => void start(), stop };
}

/**
 * The recording line inside the idea field (PIN-216): a dot, elapsed
 * over the Policy cap, and what is happening. It covers the field
 * without changing its size; Stop is the field's own mic button, so
 * focus never jumps. Screen readers hear the state from the composer's
 * status line instead.
 */
export function DictationBar({ state, elapsed, maxSeconds }: { state: DictateState; elapsed: number; maxSeconds: number }) {
  const locale = useLocale();
  if (state === "idle") return null;
  return (
    <div className="pn-dictate-bar" data-state={state} aria-hidden="true">
      <span className="pn-dictate-dot" />
      {state === "recording" ? (
        <span className="pn-dictate-clock">
          {tf(locale, "make.dictateElapsed", { elapsed: clipClock(elapsed), cap: clipClock(maxSeconds) })}
        </span>
      ) : null}
      <span className="pn-dictate-text">
        {t(locale, state === "recording" ? "make.dictateListening" : "make.dictateWorking")}
      </span>
    </div>
  );
}
