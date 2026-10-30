"use client";

import { useEffect, useRef, useState } from "react";
import { t } from "../../../i18n";
import { Button, Hint } from "../../../ui";
import { blobToDictationWav } from "./dictate-audio";

type DictateState = "idle" | "recording" | "working";

/**
 * "Say it instead" dictation for the Make-sheet idea (PIN-119):
 * MediaRecorder captures a short clip, the clip is re-encoded to
 * mono 16kHz WAV, the board transcribe route runs it through the
 * decorated Muse Voice port, and the transcript is appended to
 * the idea field. Rendered only when a mic + MediaRecorder exist
 * (hidden on unsupported browsers) and only when the caller says
 * dictation is on (Policy/AI); failures are friendly lines.
 */
export function DictateButton({
  slug,
  maxSeconds,
  onText,
}: {
  slug: string;
  /** Policy dictationMaxSeconds: recording auto-stops there. */
  maxSeconds: number;
  onText: (transcript: string) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<DictateState>("idle");
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<{ recorder: MediaRecorder; stream: MediaStream; timer: number } | null>(
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopSession() {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return;
    window.clearTimeout(session.timer);
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
        setError(typeof data?.error === "string" ? data.error : t("en", "make.dictateFailed"));
        return;
      }
      onText(data.text);
    } catch {
      setError(t("en", "make.dictateFailed"));
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
      if (liveRef.current) setError(t("en", "make.dictateNoMic"));
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
    sessionRef.current = { recorder, stream, timer };
    recorder.start();
    setState("recording");
  }

  function stop() {
    if (sessionRef.current?.recorder.state === "recording") {
      sessionRef.current.recorder.stop();
    }
  }

  if (!supported) return null;

  return (
    <div className="pn-make-dictate">
      {state === "recording" ? (
        <>
          <Button icon="mic" onClick={stop}>
            {t("en", "make.dictateStop")}
          </Button>
          <Hint point="none">{t("en", "make.dictateListening")}</Hint>
        </>
      ) : (
        <Button icon="mic" disabled={state === "working"} onClick={() => void start()}>
          {state === "working" ? t("en", "make.dictateWorking") : t("en", "make.dictate")}
        </Button>
      )}
      {error ? <Hint point="none">{error}</Hint> : null}
    </div>
  );
}
