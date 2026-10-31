# 19 — Meta models in Pinneds (PIN-211)

Pinneds uses five Meta models. Four run inside the app, behind six capability ports in
`src/gateway/`; the fifth ran at build time to translate the UI. Per model: what goes in,
what comes out, which Policy keys govern it, what happens when it fails, and what we
measured. Spec: `docs/11-studio.md` §3 and §5.2; decisions:
`docs/adr/003-studio-architecture.md`; cost accounting: `docs/16-ai-usage.md`.

| Model | Runtime ID (env) | Port or entry point | Prompt | Billing unit (estimate) |
| --- | --- | --- | --- | --- |
| Muse Spark | `muse-spark-1.3` (`META_MODEL_SPARK`) | `ElementNamer`, `TapNamer`, `ChipSuggester` | `elements.v1`, `tap-name.v1`, `chips.v1` | $1.25 in / $4.25 out per 1M tokens |
| SAM 3.1 | `sam-3.1` (`META_MODEL_SAM`) | `Segmenter` | none: the concept is the prompt | $2.50 per 1,000 images |
| Muse Image | `muse-image-1.0` (`META_MODEL_IMAGE`) | `SceneComposer` | `scene.v1` | flat $0.01 per generated image |
| Muse Voice Transcribe | `muse-voice-transcribe-1.0` (`META_MODEL_VOICE`) | `SpeechTranscriber` | none: speech to text | $3 per 1,000 audio-minutes |
| Muse Spark Open (Baseten) | `meta-models/muse-spark-open-1026` (`I18N_MODEL`) | `scripts/i18n-translate.mjs`, build time only | `translate-ui.v1`, `review-ui.v1` | tokens, capped by `--max-usd` |

Runtime IDs come from `src/config.ts` (`DEFAULT_META_MODELS`, overridable by env);
`Policy.models` only labels the AI call log. Prices live in `src/gateway/costs.ts` (Meta
list prices, Oct 30). Every dollar figure here is an estimate; the provider dashboard is
authoritative.

## The shared path for every runtime call

- **Adapters.** `src/gateway/ports.ts` defines the ports. `getCapabilityPorts`
  (`src/gateway/index.ts`) returns the mock adapters (`mock-ports.ts`) under `AI_MOCK=1`,
  the default, and the Meta adapters (`meta-ports.ts` over `meta-gateway.ts`: plain
  `fetch` to `META_API_BASE_URL`, no provider SDK) otherwise. `fixture-ports.ts` replays
  the PIN-50 spike (`eval/fixtures/studio/fixtures.json`) for contract tests.
- **Decorators.** Product code only gets the decorated ports (`src/server/ai-ports.ts`).
  `decoratePorts` (`src/gateway/decorators.ts`) runs: timeout (Policy `timeoutsMs`) → one
  retry on 429/5xx (`retries`, `retryBackoffMs`) → reserve budget, fail closed
  (`src/gateway/budget.ts`: `dailyBudgetUsd`, `dailyCallLimit` and the per-port caps
  below) → call → one `AiCallLog` row with units, `promptVersion` and estimated cost →
  a typed `ready / failed / refused` outcome.
- **Refusals.** `classifyPortError` maps refusal and content-policy codes to `refused`.
  Callers turn `failed` and `refused` into a friendly line or a fallback, never a 500.
- **Images out** leave as inline `data:` URLs built from the stripped working copy or a
  stored cut-out: never a signed URL, never the original upload (`docs/06-photo-intake.md`).
- **Prompt versions** come from `Policy.promptVersions` and are stored with what they
  made: `DecomposeJob` (elements), `Scene` and `SceneJob` (scene), the chips cache entry,
  and every `AiCallLog` row (`src/domain/board.ts`, `src/domain/chips.ts`).

## Muse Spark (`muse-spark-1.3`)

Three calls, all `POST /chat/completions` with a system prompt filled from Policy and a
JSON-only reply.

**Name the things in a photo (`ElementNamer`).** Prompt `prompts/elements.v1.md`
(`elementsSystemPrompt`, `normalizeElements`), called by `src/server/decompose-job.ts`.

- Policy: `elementsPerPhoto` (1–6), `conceptMaxWords` (3), `elementLabelMaxChars` (60),
  `maxTokens.sparkElements` (4,000), `timeoutsMs.spark` (30 s),
  `photosPerParticipantPerDay` (20), `faces` (`note`).
- Sent: the stripped, resized working copy (WebP data URL). Back: per thing a label, a
  SAM concept, a one-clause description and `faceFlag`; a flagged face shows the consent
  note and never blocks.
- Failure: the photo job ends `failed` or `refused` with a friendly line; a budget denial
  shows the budget line.
- Evidence (`eval/studio-findings.md` T3, 14 synthetic photos): 40 of 43 named things
  became usable pins (93%); 13 of 14 photos gave at least two; `faceFlag` was set on
  exactly the two photos with people.

**Name a tapped cut-out (`TapNamer`).** Prompt `prompts/tap-name.v1.md`.

- Policy: `conceptMaxWords`, `elementLabelMaxChars`, `maxTokens.sparkTapName` (1,200),
  `timeoutsMs.spark`, `tapNamesPerParticipantPerDay` (100).
- Sent: only the tapped cut-out flattened on white (JPEG data URL), not the photo.
- Failure: any non-ready outcome keeps the generic label ("My find") with
  `faceFlag: false`; naming never fails the tap. Live cost about $0.003 (PR #100).

**Suggest scene ideas (`ChipSuggester`).** Prompt `prompts/chips.v1.md`, service
`src/server/scene-chips.ts`.

- Policy: `chipsMax` (4), `chipsCacheTtlHours` (24), `maxTokens.sparkChips` (1,200),
  `timeoutsMs.spark`, `sceneChips` (the fixed fallback list).
- Sent: the picked pins' labels as JSON text. No images, no display names.
- Failure: the fixed `sceneChips` show at once and stay if generation fails, is refused
  or is over budget. Results are cached per label set. Mock and fixture build chips from
  the labels (`templateChips`).

## SAM 3.1 (`sam-3.1`, `Segmenter`)

- Prompt: none. A concept call sends the Spark concept; a tap sends a point prompt built
  with `buildObjectPrompt` from `@meta-sam/parser` (`buildSegmentPromptText`).
- Policy: `samConcurrency` (4 at once), `timeoutsMs.sam` (20 s), `usableMaskFrameFraction`
  (0.5%–60% of the frame), `samMinConfidence` (0), `segmentsPerPhoto` (18),
  `segmentsPerParticipantPerDay` (150). It reserves budget per attempt, so failing taps
  cannot drain the pool (PIN-92).
- Sent: `POST /responses` with the model, mask metadata (`mask_encoding`,
  `include_confidence`) and one user message: the prompt text and the working copy.
- Selection: `selectUsableSegment` (`src/server/decompose-job.ts`) keeps masks inside the
  usable window and above the confidence floor, then takes the most confident, with mask
  size as tiebreak (PIN-188). The cut-out PNG and a white-flattened JPEG go to `elements/`.
- No match: empty output means no pin for that concept, not an error. The mock returns a
  synthetic mask; the fixture replays the recorded box with a placeholder mask.
- Evidence: one concept call bills one image (`usage.images_processed=1`, T5); photo to
  pins took 10.6 s mean, 17.2 s max locally (T4) and 13.2 s mean on hosted dev (PIN-67);
  about $0.02 a photo with Spark naming (T5).

## Muse Image (`muse-image-1.0`, `SceneComposer`)

- Prompt: `prompts/scene.v1.md`, built by `buildSceneResponsesBody` (`sceneElementLabel`,
  `scenePromptText`, `PARENT_SCENE_LABEL`); job in `src/server/scene-job.ts`.
- Policy: `pinsPerScene` (1–4), `sceneInputMode` (`flattened`), `sceneSize`
  (`1024x1536`), `sceneStore` (`false`), `timeoutsMs.scene` (120 s), `scenePromptMaxChars`
  (500), `flattenedMaxPx` (1,024), `scenesPerParticipantPerDay` (10),
  `scenesPerBoardPerDay` (40), and `credits.*` when credits are on.
- Sent: `POST /responses` with only `model`, `store`, `input` and
  `tools: [{type: "image_generation", size}]`. Per pin a text label
  "Element N (from <display name>): label — description", then the flattened cut-out; the
  idea comes last. Owners' display names reach Muse Image only as these credit labels.
- Remix: the parent scene image goes first with the base-scene label, then the new pins.
  Stateless: no `previous_response_id`, and `store` is always `false` for a remix.
- Refusal: HTTP 200 with no image is `refused` (`sceneImageOutcome`): a friendly line,
  priced $0. Over budget, AI off or no creations left: a free collage of the cut-outs made
  with sharp (`kind: "collage"` plus a `collageReason`), never debited. Under `AI_MOCK=1`
  every scene is a collage; the fixture adapter replays recorded scenes, refusals included.
- Evidence (`eval/studio-findings.md`): fidelity 4.86/5 over 14 composed things, judged
  by Spark as a proxy (T1); flattened inputs 5.00 against 4.89 for transparent and
  whole-photo (T2); 14.4 s mean, 27.2 s max over 25 scenes (T4); 0 of 10 harmless prompts
  refused, 3 of them with synthetic people (T6); a live remix in 27.9 s (PIN-79).
- Showcase photos: Muse Image also made the source photos of the try-on and cat landing
  sets, text to image through `POST /images/generations`, run by the operator outside the
  app (`docs/17-showcase-sets.md` §2). Their cut-outs and scenes came from this app's
  pipeline: 8 of 8 scenes ready, 15.9 s mean (`eval/showcase/README.md`).

## Muse Voice Transcribe (`muse-voice-transcribe-1.0`, `SpeechTranscriber`)

- Prompt: none. Service `src/server/dictation.ts`, route
  `src/app/api/boards/[slug]/transcribe/route.ts`.
- Policy: `dictationMaxSeconds` (30), `dictationMaxBytes` (1 MiB),
  `dictationsPerParticipantPerDay` (50), `timeoutsMs.voice` (60 s), `scenePromptMaxChars`
  (caps the transcript).
- Sent: `POST /asr/transcribe`, multipart: a JSON part (`mode: PUSH_TO_TALK`, model,
  `audioEncoding: WAV`) and the clip (mono 16-bit PCM WAV, encoded in the browser). The
  server checks the WAV header against the caps first. The audio stays in memory for the
  call and is never stored.
- Failure: silence or a refusal is a friendly "Nothing was heard" (400); budget denials
  answer 429; provider failures a friendly 503. The mock returns a fixed transcript.
- Evidence: billed per whole audio-second; about $0.00015 for a 2.5 s clip (PR #106).

## Muse Spark Open on Baseten (build time only)

- Entry: `npm run i18n:translate` (`scripts/i18n-translate.mjs`), run by hand by the
  operator with `BASETEN_API_KEY`. Never called by the running app, never in CI.
- Prompts: `prompts/translate-ui.v1.md` translates batches of
  `src/i18n/messages/en.json` with the glossary (`src/i18n/glossary.json`) and register
  rules; a second Spark Open pass with `prompts/review-ui.v1.md` fixes register, terms and
  placeholders. Each `<locale>.lock.json` hashes the English text with the prompt version,
  so only new or changed strings are sent.
- Sent: UI strings only, no user data. `--max-usd` (default 5) stops before a call could
  pass it.
- Evidence: six languages, first pass $0.98 in all, about $0.16 each (`docs/18-i18n.md`).
  No native-speaker review yet.

## What leaves the server

| Call | Sent to Meta | Never sent |
| --- | --- | --- |
| Name things | stripped working copy | the original upload, EXIF |
| Tap name | one flattened cut-out | the rest of the photo |
| Chips | pin labels | images, display names |
| SAM cut | working copy + concept or point | the original upload, EXIF |
| Compose | flattened cut-outs (plus the parent scene for a remix), labels with owners' display names, the idea; `store: false` | original photos, board links |
| Dictation | the WAV clip, held in memory only | anything stored afterwards |

Every runtime call runs in Standard mode: not used for training, which is not the same as
not stored (`docs/11` §4). Only the Muse Image compose call sends `store: false`; we make
no "zero data retention" claim. SAM cuts can send `store: false` too through `Policy.samStore`
(unset today), once a live probe shows SAM accepts it (`docs/16`).

## Not made with Meta models

The classic landing set (`public/landing/sets/classic/`), the `/new` look-picker samples
(`public/start/`), the board theme art (`public/themes/`) and the eval fixture photos
(`eval/fixtures/studio/`) are Higgsfield images; SAM 3.1 cut out the classic and sample
stickers in the PIN-50 spike (`public/landing/README.md`, `public/start/README.md`).
