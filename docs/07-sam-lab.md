# 07 — SAM lab (PIN-36)

Dev-only tool at `/lab/sam` (enabled by `PINNED_LAB=1` on dev, or
locally in memory mode; 404 elsewhere). Built to learn what SAM 3.1
actually returns on real uploads before it was wired into the
photo flow. With `AI_MOCK=1` the lab renders a labelled synthetic
ellipse mask so the UI and compositing stay exercisable offline.

## What SAM 3.1 does and does not do (Meta docs, Oct 2026)

- One **concept per request**: a short noun phrase ("red stapler").
  Commands, questions, comma lists, negation, and spatial phrasing
  ("on the left") return zero or unreliable matches. This is why
  the pin flow is Spark names the object → SAM cuts it.
- Or **box/point prompts** in the same token grammar as the output
  (`buildObjectPrompt` from `@meta-sam/parser`). Points support
  negative labels; this is the tap-to-add mechanism.
- No match is a normal empty result, never an error. The app must
  degrade gracefully (the pin simply does not appear; tap-to-add is
  the workaround).
- Output is geometry: one box + one base85 mask per match. The
  mask raster covers the box at `x1,y1` (wire coords inclusive).
  Decode with Meta's `@meta-sam/parser` (`decodeMaskToRaster`);
  its payload argument includes the encoding marker char.
- `metadata.mask_encoding`: `lossless` (`~`) default, `one_bit`
  (`!`) several times smaller. Box/point prompts always return
  `one_bit`. `metadata.include_confidence: "true"` adds per-record
  confidence.
- Server compositing (`src/server/sam-mask.ts`, sharp): overlay,
  transparent cut-out, mask PNG, coverage stats.

## Using the lab

1. Photo: any JPEG/PNG/WebP ≤10 MB. It goes through the real
   PIN-34 intake, so what you see is the working derivative SAM
   would get in the app.
2. ✏️ Name it: type a noun phrase, or ✨ Auto-name to run the
   Spark label first (the Spark → SAM hand-off).
3. 👆 Tap it: tap = on the object, Shift+tap = not the object.
4. ⬚ Box it: drag a box.
5. Read the result: segment chips by colour, % of photo covered,
   confidence, and Overlay / Cut-out / Mask / Photo views. The
   exact prompt sent is under "Prompt sent".

## Findings log

Record dated observations here (photo kind, prompt, outcome,
latency). Patterns here decide defaults: concept wording, when to
offer tap-to-add, and fallback thresholds.

| Date | Photo | Prompt | Result | SAM ms | Notes |
| ---- | ----- | ------ | ------ | ------ | ----- |
| 2026-10-27 | Muse Image desk scene, 1600×1067 derivative | `red stapler` | 1 segment, conf 0.98, 7.7% of frame, 69.7% of box | 3,070 | Overlay pixel-accurate; cut-out alpha verified (69.7% opaque). |
| 2026-10-27 | same | tap at stapler centre | IoU 0.993 vs concept box | — | Tap-to-add is viable. |
| 2026-10-27 | same | `purple elephant` | 0 segments, HTTP 200 | — | Absent concept = empty, app must fall back gracefully. |
| 2026-10-27 | same | ✨ auto-name | label said `red stapler` → 1 segment | — | Spark label → SAM hand-off works as designed. |
