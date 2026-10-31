/**
 * Start a recorder on an open mic stream (PIN-232). Building a
 * MediaRecorder (a stream the browser cannot record) and `start()`
 * can both throw. Once the stream is open the mic light is on, so a
 * throw must not leave it that way with nobody holding it: the
 * tracks are stopped here and the caller gets `null` to show the
 * "no mic" line. `attach` runs between building and starting, so
 * the handlers are in place before the first chunk can arrive.
 */
export function startRecorder(
  stream: MediaStream,
  attach: (recorder: MediaRecorder) => void,
  create: (stream: MediaStream) => MediaRecorder = (source) => new MediaRecorder(source),
): MediaRecorder | null {
  try {
    const recorder = create(stream);
    attach(recorder);
    recorder.start();
    return recorder;
  } catch {
    stopStream(stream);
    return null;
  }
}

/** Turn the mic off: every track of the stream, even if one refuses to stop. */
export function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track that is already gone has nothing left to release.
    }
  }
}
