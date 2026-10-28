"use client";

import {
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

type Mode = "concept" | "points" | "box";
type View = "overlay" | "cutout" | "mask" | "original";

interface LabPoint {
  x: number;
  y: number;
  label: "positive" | "negative";
}
interface LabBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
interface LabSegment {
  id: string;
  box: LabBox;
  confidence: number | null;
  maskPixels: number;
  coverageFramePct: number;
  coverageBoxPct: number;
  cutoutPng: string;
  maskPng: string;
}
interface LabResult {
  mock: boolean;
  image: { width: number; height: number; dataUrl: string };
  promptUsed: string;
  label: { objectLabel: string; altLabel: string } | null;
  timingsMs: { intake: number; segment: number; total: number };
  segments: LabSegment[];
  overlayJpeg: string;
}

const COLORS = ["#ff3b30", "#007aff", "#34c759", "#ff9500", "#af52de", "#ffcc00", "#00c7be", "#ff2d55"];
const MAX_BYTES = 10 * 1024 * 1024;

export function SamLab({ aiMock }: { aiMock: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [mode, setMode] = useState<Mode>("concept");
  const [concept, setConcept] = useState("");
  const [autoLabel, setAutoLabel] = useState(false);
  const [points, setPoints] = useState<LabPoint[]>([]);
  const [box, setBox] = useState<LabBox | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [oneBit, setOneBit] = useState(false);
  const [confidence, setConfidence] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<LabResult | null>(null);
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<View>("overlay");
  const stageRef = useRef<HTMLDivElement | null>(null);

  function pickFile(next: File | null) {
    if (preview) URL.revokeObjectURL(preview);
    setFile(next);
    setPreview(next ? URL.createObjectURL(next) : "");
    setPoints([]);
    setBox(null);
    setResult(null);
    setError(next && next.size > MAX_BYTES ? "Too big — 10 MB max." : "");
  }

  function fractions(event: ReactPointerEvent): { x: number; y: number } | null {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  function onStagePointerDown(event: ReactPointerEvent) {
    const at = fractions(event);
    if (!at || !file) return;
    if (mode === "points") {
      const label = event.shiftKey || event.altKey ? "negative" : "positive";
      setPoints((prev) => [...prev.slice(-19), { ...at, label }]);
    } else if (mode === "box") {
      stageRef.current?.setPointerCapture(event.pointerId);
      setDragStart(at);
      setBox({ x1: at.x, y1: at.y, x2: at.x, y2: at.y });
    }
  }

  function onStagePointerMove(event: ReactPointerEvent) {
    if (mode !== "box" || !dragStart || (event.buttons & 1) === 0) return;
    const at = fractions(event);
    if (!at) return;
    setBox({
      x1: Math.min(dragStart.x, at.x),
      y1: Math.min(dragStart.y, at.y),
      x2: Math.max(dragStart.x, at.x),
      y2: Math.max(dragStart.y, at.y),
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || !file) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("photo", file);
      form.set("mode", mode);
      form.set("concept", concept);
      form.set("autoLabel", autoLabel ? "1" : "0");
      form.set("maskEncoding", oneBit ? "one_bit" : "lossless");
      form.set("includeConfidence", confidence ? "1" : "0");
      if (mode === "points" && points.length) form.set("points", JSON.stringify(points));
      if (mode === "box" && box) form.set("box", JSON.stringify(box));
      const response = await fetch("/api/lab/sam", { method: "POST", body: form });
      const data = (await response.json()) as LabResult & { error?: string };
      if (!response.ok) throw new Error(data.error || "Run failed.");
      setResult(data);
      setSelected(0);
      setView("overlay");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Run failed.");
    } finally {
      setBusy(false);
    }
  }

  const segment = result?.segments[selected] ?? null;
  const stageImage =
    view === "overlay" && result
      ? result.overlayJpeg
      : view === "cutout" && segment
        ? segment.cutoutPng
        : view === "mask" && segment
          ? segment.maskPng
          : result
            ? result.image.dataUrl
            : preview;

  return (
    <form onSubmit={onSubmit}>
      {aiMock ? (
        <p className="notice" role="status">🧪 Mock mode — ellipse preview, SAM not called.</p>
      ) : null}

      <section className="card">
        <div className="field">
          <label htmlFor="lab-photo">📷 Photo</label>
          <input
            id="lab-photo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
        </div>

        <div className="seg-control" role="tablist" aria-label="Prompt mode">
          <button type="button" role="tab" aria-selected={mode === "concept"} className={mode === "concept" ? "seg active" : "seg"} onClick={() => setMode("concept")}>✏️ Name it</button>
          <button type="button" role="tab" aria-selected={mode === "points"} className={mode === "points" ? "seg active" : "seg"} onClick={() => setMode("points")}>👆 Tap it</button>
          <button type="button" role="tab" aria-selected={mode === "box"} className={mode === "box" ? "seg active" : "seg"} onClick={() => setMode("box")}>⬚ Box it</button>
        </div>

        {mode === "concept" ? (
          <div className="field">
            <label htmlFor="lab-concept">Object</label>
            <input
              id="lab-concept"
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              placeholder="red stapler"
              disabled={autoLabel}
            />
            <label className="choice">
              <input type="checkbox" checked={autoLabel} onChange={(e) => setAutoLabel(e.target.checked)} />
              <span>✨ Auto-name (Spark)</span>
            </label>
          </div>
        ) : null}
        {mode === "points" ? (
          <p className="field-help">Tap = on object 🟢 · Shift+tap = not object 🔴
            {points.length ? (
              <>
                {" "}· <button type="button" className="btn btn-small" onClick={() => setPoints((p) => p.slice(0, -1))}>↩ Undo</button>
                {" "}<button type="button" className="btn btn-small" onClick={() => setPoints([])}>🗑 Clear</button>
              </>
            ) : null}
          </p>
        ) : null}
        {mode === "box" ? <p className="field-help">Drag a box around the object.</p> : null}

        <div className="lab-row">
          <label className="choice">
            <input type="checkbox" checked={confidence} onChange={(e) => setConfidence(e.target.checked)} />
            <span>Confidence</span>
          </label>
          <label className="choice">
            <input type="checkbox" checked={oneBit} onChange={(e) => setOneBit(e.target.checked)} />
            <span>one_bit mask</span>
          </label>
        </div>

        <div
          className="lab-stage"
          ref={stageRef}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={() => setDragStart(null)}
          onPointerCancel={() => setDragStart(null)}
        >
          {stageImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={stageImage} alt="Lab subject" draggable={false} className={view === "cutout" ? "checker" : undefined} />
          ) : (
            <p className="lab-empty">📷 Pick a photo</p>
          )}
          {!result && mode === "points"
            ? points.map((p, i) => (
                <span
                  key={i}
                  className={p.label === "positive" ? "lab-dot pos" : "lab-dot neg"}
                  style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                />
              ))
            : null}
          {!result && mode === "box" && box ? (
            <span
              className="lab-box"
              style={{
                left: `${box.x1 * 100}%`,
                top: `${box.y1 * 100}%`,
                width: `${(box.x2 - box.x1) * 100}%`,
                height: `${(box.y2 - box.y1) * 100}%`,
              }}
            />
          ) : null}
        </div>

        {error ? <p className="error" role="alert">{error}</p> : null}
        <button className="btn btn-primary" type="submit" disabled={busy || !file}>
          {busy ? "⏳ Cutting…" : "✂️ Segment"}
        </button>
      </section>

      {result ? (
        <section className="card" aria-live="polite">
          <h2>{result.segments.length ? `${result.segments.length} found` : "Nothing found"}</h2>
          <dl className="facts">
            <div><dt>⏱ Total</dt><dd>{result.timingsMs.total} ms</dd></div>
            <div><dt>✂️ SAM</dt><dd>{result.timingsMs.segment} ms</dd></div>
            <div><dt>🖼 Size</dt><dd>{result.image.width}×{result.image.height}</dd></div>
            <div><dt>Mock</dt><dd>{result.mock ? "yes" : "no"}</dd></div>
          </dl>

          <div className="lab-chips" role="listbox" aria-label="Segments">
            {result.segments.map((s, i) => (
              <button
                key={s.id + i}
                type="button"
                role="option"
                aria-selected={selected === i}
                className={selected === i ? "chip active" : "chip"}
                onClick={() => setSelected(i)}
              >
                <span className="chip-dot" style={{ background: COLORS[i % COLORS.length] }} />
                #{s.id} · {s.coverageFramePct}%
                {s.confidence !== null ? ` · ${(s.confidence * 100).toFixed(0)}% sure` : ""}
              </button>
            ))}
          </div>

          <div className="seg-control" role="tablist" aria-label="View">
            {(["overlay", "cutout", "mask", "original"] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                className={view === v ? "seg active" : "seg"}
                onClick={() => setView(v)}
              >
                {v === "overlay" ? "🎨 Overlay" : v === "cutout" ? "✂️ Cut-out" : v === "mask" ? "⬛ Mask" : "📷 Photo"}
              </button>
            ))}
          </div>

          {segment ? (
            <dl className="facts">
              <div><dt>Box</dt><dd>{segment.box.x1},{segment.box.y1} → {segment.box.x2},{segment.box.y2}</dd></div>
              <div><dt>Of photo</dt><dd>{segment.coverageFramePct}%</dd></div>
              <div><dt>Of box</dt><dd>{segment.coverageBoxPct}%</dd></div>
              <div><dt>Pixels</dt><dd>{segment.maskPixels.toLocaleString()}</dd></div>
            </dl>
          ) : (
            <p>No match. Try a shorter name — a plain noun, like “red mug”.</p>
          )}

          <details>
            <summary>Prompt sent</summary>
            <pre className="lab-raw">{result.promptUsed}</pre>
            {result.label ? <p className="field-help">✨ {result.label.objectLabel} — {result.label.altLabel}</p> : null}
          </details>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setResult(null);
              setView("overlay");
            }}
          >
            ↺ New run
          </button>
        </section>
      ) : null}
    </form>
  );
}
