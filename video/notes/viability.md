# Overnight viability test: AI story + real app footage (Oct 31 – Nov 1)

_Media (generated stills, video, audio, app recordings, renders) lives in the local video
workspace (`PINNEDS_VIDEO_DIR`), not in git. Paths like `out/…` and `gen/…` are relative to it;
every generation is listed with its job id in the workspace's `gen/costs.csv`._

**Verdict: viable.** A 66 s Halloween cut was produced overnight with no human footage: six
Higgsfield story shots, real app recordings of dev.pinneds.com (live Meta models), AI narration,
captions and an end card, assembled by a script. The 3-minute version is mainly an edit and
recording job now, not a generation-cost problem: ≈ 200 more credits.

Outputs: `out/pinneds_halloween_60s_v2_juno.mp4` (female narrator) and
`out/pinneds_halloween_60s_v2_miles.mp4` (male narrator). Same picture.

## 1. Costs

| | Credits | Notes |
|---|---|---|
| Kling 3.0 pro video (8 jobs) | 100.0 | 6 shots used + 1 bake-off + 2 re-rolls |
| Video bake-off, other models | 59.0 | Seedance 2.5 (35), Veo 3.1 Lite (12), MiniMax H3 (12) |
| GPT Image 2.5 stills (12 jobs) | 33.0 | 4 "phone photos", cast anchor, 7 shot stills |
| Seed Audio narration (17 jobs) | 6.2 | 8 lines × 2 voices + Maya's spoken idea |
| **Total** | **198.2** | of 1,200 approved; balance 3,477.65 (log = balance) |
| Meta Model API on dev (estimate) | ≈ $0.22 | 8 photos, 5 scenes, 4 transcriptions, 2 tap-cuts |

What the 60 s cut itself consumed: ≈ 110 credits. Failed jobs (rate limit, upload 520,
moderation false positive) were never charged.

## 2. Higgsfield findings
- **CLI works end to end** (`@higgsfield/cli` 1.1.26): `generate cost` quotes free;
  `generate create --wait --json` returns a CDN URL. `video/hf.mjs` wraps quote → cap → create →
  download → `gen/costs.csv`.
- **Concurrency cap: 8 jobs** (Ultra). Above it, jobs are refused before charge.
- **Stills:** GPT Image 2.5 high 2K 16:9, 2.75 credits, 30–45 s. A cast-anchor image + the
  matching object photo as references kept four faces and costumes consistent across all shots.
- **Video bake-off** (same start frame):

| Model | Credits | Output | Time | Verdict |
|---|---|---|---|---|
| **Kling 3.0 pro, 5 s** | 12.5 | 1912x1080, 24 fps, ambient sound | ~2 min | **House model**: sharpest, stable faces |
| Seedance 2.5 720p, 5 s | 35 | 1280x720, sound | ~6.5 min | More motion, softer, 3x price |
| Veo 3.1 Lite, 8 s | 12 | 1280x720, silent | ~1.5 min | Turned the phone screen to camera |
| MiniMax H3, 6 s | 12 | 1080p-ish | ~16 min | Too slow |
| Kling 4.0, 5 s | 16.25 | — | — | Upload error, not retried |

- **Failure modes to QC for, every shot:** (1) phones turning to camera with an invented app
  screen (would read as faked product UI); (2) body artefacts (a hand turned grey). One re-roll
  with explicit wording fixed each. Rule: frame-by-frame check before a shot enters a cut.
- **Voice:** Seed Audio presets, ≤ 0.6 credits a line, ~25 s. Takes carry 0.5–2 s of silence,
  trimmed automatically. Pronunciation of "Pinneds" and "Muse" not yet checked by ear.
- **Music: not solved.** No Suno in the catalogue, Sonilo/Mirelo are "game pipeline only", no
  music apps, and a Seed Audio music prompt was refused as "nsfw" (uncharged). The cut has
  narration + Kling party ambience only.

## 3. App footage findings (real recordings, dev.pinneds.com)
- Scripted Playwright capture (phone viewport @3x via CDP screencast, Chromium
  `--force-device-scale-factor=3`) gives sharp 1170x2532 frames at 30 fps. A white touch dot is the
  only overlay. Dictation used a fake microphone fed with Maya's AI voice, so Muse Voice Transcribe
  really transcribed it.
- Real waits: photo → pins 13–17 s; scene 17–27 s; dictation transcript ~4 s. All shortened in
  the edit and **marked on screen** ("real scene wait 27 s, shortened", "sped up 1.5x").
- Muse Image output is the star: the hero scene (Leo's cat in Maya's hat on Maya's broom past
  Sam's jack-o'-lantern moon) and the remix (+ Ana's skate, "haunted roller disco") look great,
  and the "Made from" credits read cleanly in a punch-in.
- Product issues seen (not filed; for you to triage):
  1. Roller skates in photo D not detected; recovered with tap-to-add (a good feature beat).
  2. Bat string lights in photo C not detected on the final upload.
  3. "Pumpkin Cat" cut-out rough (head + tail, costume body mostly missing).
  4. First dictation take came back truncated ("…flying past a"); most likely headless-browser
     lag stopping the recorder early, not the app; a longer hold fixed it.
- Board deleted afterwards through the app's host-only delete (204, then 404). The local link
  and cookies were removed.

## 4. Edit pipeline (`video/build.mjs` + a JSON cut list)
- Story shots full-frame; app clips inside a phone frame (rounded mask + bezel) over a blurred,
  darkened still of the same story moment, with a title, a model tag, an honest-wait note, and an
  optional punch-in (enlarged crop of the app, used for the credits).
- Narration and captions anchor to segment IDs, so re-timing one segment never desyncs the rest.
- End card in the app's own OFL fonts (Bricolage Grotesque, Atkinson Hyperlegible).
- Loudness-normalised (measured −15.6 LUFS), H.264 + AAC, burned captions. 66 s builds in ~1 min.
- Shwe reuse: the ideas (cut-list-driven assembly, loudness gate, length check, captions) were
  reused; the code was rewritten smaller rather than adapted.

## 5. What the 3-minute version needs (see `video/storyboard/v1-3min-outline.md`)
- ≈ 8 more story shots + re-rolls ≈ 175 credits; narration ≈ 18; total ≈ 200.
- Re-record the app on **pinneds.com after the Nov 1 promotion** (same scripts), so the final
  footage is prod. Add: tap-to-add on a missed thing, the Board Plus purchase (live, or Stripe
  test mode on dev, stated), a busy board.
- Decide music (below).
- Wall clock: ~half a day of agent time + your review passes.

## 6. Decisions for you
1. **Narrator:** Juno (female) or Miles (male).
2. **Music:** (a) Google Lyria via OpenRouter as in Shwe, needs your key; (b) a licensed
   library track (e.g. YouTube Audio Library for a YouTube-hosted video); (c) ask Higgsfield
   whether Sonilo may be used outside games.
3. **App footage source for the final:** scripted capture on prod (consistent, re-recordable;
   recommended) or real phone screen recording.
4. **Pace:** this cut is ~66 s; a strict 60 s needs ~6 s out (e.g. S5b and part of S7b).
