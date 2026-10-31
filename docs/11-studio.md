# 11 — Pinneds Studio (PIN-49)

_Status: source of truth for the Studio pivot from Oct 28, 2026.
Built from spec sections 1–8 of the Oct 28 hand-off (PIN-48),
including amendments A1–A6. The game it replaces is archived in
`docs/archive/` (01, 02, 05). Architecture decisions:
`docs/adr/003-studio-architecture.md`._

> **Findings ownership (A1):** only PIN-49 edits this file. PIN-50
> writes spike results to `eval/studio-findings.md`; a later docs
> update folds them into the Findings table in §8. No other issue
> edits `docs/11` without first landing behind the PIN-49 merge.

## 1. Product

Pinneds is a shared pinboard of real things.

- Anyone with the board link uploads a photo. Muse Spark names the
  things in it, SAM 3.1 cuts each one out, and the cut-outs are pinned
  to the board with the owner's name.
- Anyone then picks a few pins from anyone, writes or taps a scene
  prompt, and Muse Image composes them into a new image. The image
  lands in the board's gallery, credited to the people whose things
  are in it.
- Scenes can be remixed.
- There are no accounts: the link is the invitation.
- Solo works too (a board with one person), and that is also the
  judge demo.

Logistics:

- **Name:** Pinneds (domain pinneds.com; see `docs/10`). Share links
  stay `/g/{slug}`.
- **First real board:** family and friends, target Sat Oct 31. The
  hackathon Discord only if ready.
- **Hackathon:** Meta Global AI Developer Hackathon, Indie track,
  "Build for Your World". Freeze Tue Nov 3 end of day; submit by
  Wed Nov 4, 9:00 PM ET (03:00 Nov 5 Paris time). It needs a public
  repo, a video of about 3 minutes, and a deployed product. Demo
  only work built during the event.

## 2. Decisions (Robin, Oct 27–28)

| Topic | Decision |
| --- | --- |
| People in pins | Allowed. When Spark flags a face, show a one-line consent note ("everyone in this photo OK with being remixed?"). Never block. Meta's guardrails refuse what they refuse; the app shows a refusal as a friendly message, never an error. Policy: `faces: allow / note / block`, default `note`. |
| No hard-coded limits | Every count, size, cap, timeout and TTL comes from one Policy object (§5.1). |
| Process | Firebase App Hosting dev/prod and the required Bugbot check stay. |
| Testing | Muse Code runs the live tests itself with synthetic images from Higgsfield. Robin reviews later; he is not a gate. |
| Identity and persistence | Design it now (owned elements, persistent scenes, `ownerId` everywhere). Sign-in comes later behind `AUTH_MODE`. |
| The game | Dropped: judging, rubric, roast levels, personas, deadlines, reveal and guessing, diary. Code removal: PIN-52. |

## 3. Verified API facts: use these, not memory

### Muse Image 1.0 (`muse-image-1.0`)

- **Endpoint.** Reference images and multi-turn work go through
  `POST /v1/responses` (OpenAI-compatible Responses API, base
  `https://api.meta.ai/v1`). Today's gateway uses
  `/v1/images/generations`, which is text only, so add a `/responses`
  path.
- **Reference images.** Send `input_image` parts (public URL or `data:`
  URL) together with `input_text` parts, inside
  `{"role":"user","content":[...]}`. A bare list of parts returns
  HTTP 400. Several images in one message are composed into one scene.
- **Output.** `response.output` is a list of `reasoning`, `message`
  and `image_generation_call` items; the image is base64 in
  `image_generation_call.result`.
- **Size.** `tools: [{"type":"image_generation","size":"1536x1024"}]`
  is in the cookbook. `output_format` and `reasoning_strength` are
  not documented, so don't send them until a test shows they're
  accepted. Check which portrait sizes are accepted.
- **State.** `store` defaults to `true`: the server keeps the
  conversation, and `previous_response_id` chains turns. With
  `store: false`, replay the prior `image_generation_call` item.
  Standard mode means *not used for training*, not *not stored*.
- **Billing.** On `/responses` you pay per token. The cookbook's
  compose example used about 16.5k input tokens (about 11k cached)
  and 1.1k output tokens. Measure cost per scene from `usage`.
- **Faithfulness.** Per the cookbook, items shown on their own on a
  plain white background stay faithful when composed later.
- **Source:** github.com/meta-models/meta-model-cookbook, folders
  `05_muse_image/01` to `04`.

### SAM 3.1 (`sam-3.1`)

- **Endpoint.** `POST /v1/responses`, one concept (a short noun
  phrase) per request. Lists, spatial phrases and questions return
  zero or unreliable matches. Empty output means no match, not an
  error.
- **Box and point prompts.** Build them with `buildObjectPrompt` from
  `@meta-sam/parser` 0.1.0, never by hand. Negative points are
  allowed; Meta's docs allow up to 16 objects per request.
- **Masks.** `metadata.mask_encoding` is `lossless` (`~`, the default)
  or `one_bit` (`!`); box and point prompts always return one-bit.
  `metadata.include_confidence: "true"` adds a confidence value.
- **Decoding.** Use `@meta-sam/parser` (`decodeMaskToRaster`,
  `decodeMaskToSVGPath`, `decodeMaskToRLE`). Compositing lives in
  `src/server/sam-mask.ts`.
- **Price.** $2.50 per 1,000 images. Assume each concept call bills
  as one image, and confirm.

### Measured (repo `docs/archive/02`, `docs/07`)

| Call | Time |
| --- | --- |
| Spark persona (text) | 6.9 s |
| Spark vision judge | 11.1 s |
| SAM, per call | 3.1–4.6 s |
| Muse Image, text only (`/images/generations`) | 10.6 s |

A tap prompt reproduced the concept mask at IoU 0.993 (`docs/07`).

## 4. Corrections to the draft proposal

- **SAM speed.** Not "4 SAM calls in about 1–1.5 s": plan for 3–5 s,
  and show pins as each call returns.
- **Mask prefix.** `one_bit` uses `!`, not `~`.
- **Retention claim.** Drop "zero data retention": a remix with
  `previous_response_id` relies on stored state.
- **Raw photo.** "Discarded immediately" conflicts with tap-to-add.
  Keep the existing stripped working copy from photo intake (`tmp/`)
  until pins are chosen, for at most `workingCopyTtlHours`. The
  original upload is never stored.
- **Categories.** Drop the pin `category` taxonomy. Roles, if any,
  are chosen in the scene tray.
- **Slugs.** They are 128-bit base64url, not Base62
  (`src/domain/tokens.test.ts`: `^[A-Za-z0-9_-]{22}$`).
- **Image tool keys.** Don't send `output_format` or
  `reasoning_strength` until verified.

## 5. Architecture

### 5.1 Policy (no hard-coded limits)

One typed `Policy`: a Zod schema with defaults in code, overridden
in this order by env, then per-board overrides. Prompts receive the
numbers as variables, and validators and the UI read the same
object. The defaults below are proposals; tune them from evidence.

> **A3:** Firebase Remote Config is deferred. v1 is defaults + env +
> board overrides only. Revisit only if a redeploy-free knob change
> becomes a real need.

| Key | Proposed default |
| --- | --- |
| `elementsPerPhoto.min` / `.max` | 1 / 6 |
| `conceptMaxWords` | 3 |
| `pinsPerScene.min` / `.max` | 1 / 4 |
| `photosPerParticipantPerDay` | 20 |
| `scenesPerParticipantPerDay` | 10 |
| `scenesPerBoardPerDay` | 40 |
| `workingCopyTtlHours` | 24 (see A6 in §5.5) |
| `faces` | `note` |
| `sceneInputMode` | `flattened` (slice 0 decides) |
| `sceneSize` | portrait (check which values are accepted) |
| Timeouts in ms: Spark / SAM / scene | 30,000 / 20,000 / 120,000 |
| Retries on 429/5xx | 1 |
| Daily AI budget | the existing `AI_DAILY_BUDGET_USD` (see A2) |
| Models | `muse-spark-1.3`, `sam-3.1`, `muse-image-1.0` |
| Prompt versions | `elements.v1`, `scene.v1` |
| `credits.enabled` / `credits.starterMakes` | `false` / 5 (PIN-151: the makes pool, docs/15; 25 before PIN-181; off = pre-credit behaviour exactly, on = 1 make per successful photo or AI scene, collage stays free) |

> **A2 (budget):** hosted `AI_DAILY_BUDGET_USD=2` / 200 calls
> (`apphosting.dev.yaml`, `apphosting.prod.yaml`, `.env.example`) is
> too small for family play — a few scenes would exhaust it. Keep the
> local slice-0 spike cap ($25 Meta, PIN-50) separate from the hosted
> budget. Proposed hosted default: dev/prod **$10/day** plus
> per-board caps (`scenesPerBoardPerDay`, `photosPerParticipantPerDay`
> above). Robin raises the hosted value before PIN-55. `0` must mean
> "off", not the current $2 fallback
> (`src/config.ts`: `positiveNumber(env.AI_DAILY_BUDGET_USD, 2)`).

### 5.2 Model ports and decorators

- **Ports by capability:** `ElementNamer` (Spark vision to elements
  JSON), `Segmenter` (SAM concept, point or box to masks) and
  `SceneComposer` (Muse Image to image). Each has a Meta adapter, a
  mock adapter and a recorded-fixture adapter.
- **One decorator chain on every port:** timeout → retry on 429/5xx
  → reserve budget (fail closed) → call → log cost (`AiCallLog`) →
  fall back.
- **Refusals** become the outcome `refused`, with a friendly line.
  Never a 500.
- This chain also fixes the open code-review findings:
  - The budget check scans every AI log of the day. Use one counter
    doc per day with `FieldValue.increment` instead.
  - The guard checks, then calls, so parallel requests all pass, and
    failed log writes are swallowed. Reserve spend first, fail closed.
  - Creating a game has no per-IP limit.
  - Model calls have no timeout and no `max_tokens`.
  - `AI_DAILY_BUDGET_USD=0` falls back to $2. It should mean "off".
  - A `%2F` slug reaches Firestore as a path. Validate
    `^[A-Za-z0-9_-]{22}$` first.
  - Server modules lack `server-only` (verified: no `server-only`
    import under `src/` today).

### 5.3 Jobs

- `DecomposeJob` and `SceneJob` documents move
  `pending → running → ready / failed / refused`.
- They are idempotent by job id, with claim-before-call, as in the
  segment service (`src/server/segment-submission.ts`).
- The request does the work and writes the status; the client polls.
- **A4:** no queue in slices 1–2 (request + poll). Add a queue
  (Inngest or Firebase task-queue functions) only if retries get
  complex.

### 5.4 Data model

- **Participant.** One per board, signed cookie; it already exists
  (`src/server/player-session.ts`). Later it links to a **User**
  (Firebase Auth, Google) behind `AUTH_MODE`, using the claim flow
  described in `docs/archive/02`.
- **Element.** An owned asset: `ownerId`, `label`, `description`,
  mask box, cut-out ref, flattened ref, `sourcePhotoId`, `faceFlag`,
  `createdAt`.
- **Pin.** An element on a board: `boardId`, `elementId`,
  `pinnedBy`, `status` (candidate or pinned), `createdAt`.
- **Board.** Slug, title, theme, Policy overrides, counters.
- **Scene.** `boardId`, `createdBy`, `elementIds`, `prompt`,
  `status`, `imageRef`, `parentSceneId`, `promptVersion`, `costUsd`,
  `refusalReason`, `createdAt`.
- **BoardEvent.** Append-only: `element_added`, `pin_added`,
  `scene_requested`, `scene_ready`, `scene_refused`, `scene_failed`.
  It feeds the activity strip and the demo's usage numbers.
- **Deletes.** Deleting an element removes its pins and hides the
  scenes that used it.

### 5.5 Storage

- `tmp/` holds working copies, with the TTL from Policy and the
  bucket lifecycle rule as a backstop.
- `elements/` and `scenes/` are persistent.
- Everything is served through a route that checks the board link;
  client storage rules stay deny-all.
- Original uploads are never written anywhere (`docs/06`).

> **A6 (TTL gap):** the `tmp/` bucket lifecycle rule is **14 days**
> today (`storage.lifecycle.json`: `age: 14`, `matchesPrefix:
> ["tmp/"]`; `docs/06`). A 24 h `workingCopyTtlHours` therefore needs
> (a) an app-side delete once pins are chosen (or at TTL), and
> (b) an operator lifecycle fix to 1 day as the backstop. Until both
> land, do not claim 24 h deletion in user-facing copy.

### 5.6 Scene inputs

- **Default:** each element flattened on plain white, padded, at most
  1024 px, and preceded by an `input_text` label such as "Element 1
  (from Aye): orange tabby cat". The user's prompt comes last.
- **Slice 0 decides** between flattened, transparent and whole-photo
  inputs (`sceneInputMode`).

### 5.7 Remix

- **Stateless by default:** attach the parent scene image as an
  `input_image`, plus any new elements and the instruction.
- `previous_response_id` is only a same-session shortcut.

### 5.8 Client

- **Board page:** polls with TanStack Query (`refetchInterval`,
  refetch on focus, optimistic pins).
- **Uploads:** use route handlers, not server actions, and downscale
  on the client before upload.

### 5.9 Testing

- **CI** runs on `AI_MOCK=1` with recorded fixtures.
- **Golden set:** a small synthetic set checks naming and fidelity
  before any prompt or model change.
- **Live runs** happen on demand, with cost logged.

### 5.10 Themes replace presets (A5)

- The curated preset library (`docs/09`) becomes **board themes**:
  palette/type/motif tokens only. Keep the PIN-41 pre-generated art
  as theme assets.
- Host personas inside presets are deleted with the game code in
  PIN-52. Themes must cost the player zero decisions (ADR-002 spirit
  in `docs/archive/02` §9: no levels, no settings friction).

## 6. UX

**Layout.** One board page, with scenes first and the pins grid
below. A fixed bottom bar opens two sheets: 📷 Add and ✨ Make a
scene.

**Add sheet.**

1. Pick or take a photo; the sheet shows "finding things…".
2. Pins pop in as each SAM call returns, all pre-selected.
3. Tap a pin to drop it, or tap the photo to add something it missed.
4. One button: "Pin N →".

**Scene sheet.**

1. Select up to `pinsPerScene.max` pins on the board.
2. Write a prompt or tap one of 3–4 suggestion chips.
3. "Make it ✨" closes the sheet, and a "cooking…" card appears in
   the gallery.

**Scene card.** The image, "made from Robin's mug + Aye's cat",
Remix and Share (Web Share API). The board link's preview image is
the latest scene.

**Rules.**

- Never show an empty board: a theme plus "pin 3 things from where
  you are".
- A seeded demo board for judges.
- No settings knobs on screen.
- Waiting is always visible.
- Target: a new player's first scene within 90 s.
- Follow `docs/08`: an icon plus 6 words at most, 44 px targets.

## 7. Slices and schedule

| Slice | Target | Done when (evening demo) |
| --- | --- | --- |
| 0. Spikes (PIN-50) | Wed Oct 28, overnight | §8 numbers recorded; fixtures and contact sheets saved |
| 1. Photo → pins (PIN-53) | Thu Oct 29 | A photo on a phone becomes pins on the board, and a second phone sees them |
| 2. Pins → scene (PIN-54) | Fri Oct 30 | 3 pins plus a prompt give a scene in the gallery within 30 s; a mock collage works offline |
| 3. Friends and sharing (PIN-55) | Sat Oct 31 | Two phones, names, share, link preview, seeded demo board; the family board goes live on prod |
| 4. Remix and tap-to-add (PIN-56) | Sun–Mon | Remix any scene; tap to add a missed thing |
| Freeze and prod | Tue Nov 3 | Promoted to prod, dry run done |
| Video and submit | Wed Nov 4 | Submitted |

Foundations run ahead of the slices: PIN-51 (Policy + gateway,
§5.1–5.2) and PIN-52 (delete the game code, rename routes to
boards), both blocked by PIN-49. Sign-in is PIN-57 (later); the
family launch is PIN-58 (Robin).

If a day slips, cut in this order: remix → SVG outlines → chips
become a fixed list → the Discord board.

## 8. Slice 0 test plan (Muse Code runs it; Robin reviews later)

**Images.**

- Generate them with Higgsfield: about 10 realistic home or desk
  scenes with distinctive objects (a chipped teal mug, a yellow
  rubber duck in sunglasses, a brass lamp, an orange tabby cat, a
  plant in a striped pot).
- Add 2 hard cases (glass and a cable mess) and 2 scenes with
  synthetic people.
- No photos of real people. At most 60 images.

| # | Question | Method | Pass (proposed) |
| --- | --- | --- | --- |
| T1 Fidelity | Does each input element stay recognisable in the scene? | 5 scenes (2, 3 and 4 elements). Spark vision scores each element against the scene from 0 to 5, with a reason. Save a contact sheet (inputs, scene, scores) for Robin | Mean ≥ 3.5, and every element ≥ 3 in 4 of 5 scenes |
| T2 Input mode | Flattened vs transparent vs whole photo plus a pointer | The same 3 compositions in each mode, judged as in T1 | The best mean becomes `sceneInputMode` |
| T2b Label binding | Does each label bind to the image that follows it? | Swap the label order once | Record the result |
| T3 Naming | Does Spark find usable elements? | `elements.v1` plus SAM on every photo | At least 2 usable pins on 80% of photos |
| T4 Speed | How long do photo → pins and a scene take? | Timings | ≤ 15 s and ≤ 30 s |
| T5 Cost | What does a photo and a scene cost? | `usage` plus `AiCallLog` | ≤ $0.05 per photo, ≤ $0.10 per scene |
| T6 Refusals | Are harmless prompts refused, including with people? | 10 scenes, 3 with synthetic people | Fewer than 1 in 10 refused |

**Decision rules.**

- Pick the defaults from the numbers and continue.
- If T1's mean is below 2.5 in every mode, put that at the top of
  the morning review and keep building slice 1, which doesn't depend
  on T1.
- Spark judging Muse Image is a proxy. Robin's look at the contact
  sheets is final, but it never blocks.
- **A1:** PIN-50 writes results to `eval/studio-findings.md` and to
  the morning review. Only PIN-49 edits this file; the Findings
  table below stays empty in this PR.

### Findings (PIN-50, Oct 28; detail in eval/studio-findings.md)

| # | Test | Result | Decision taken |
| --- | --- | --- | --- |
| T1 | Fidelity | **PASS** - mean 4.86/5 over 14 elements in 5 flattened scenes (bar >= 3.5); every element >= 3 in 5/5 scenes (bar 4/5). Spark judge is a proxy; contact sheets in eval/contact-sheets/. | Compose from cut-outs is viable; slice 2 proceeds. |
| T2 | Input mode | Flattened 5.00 > transparent 4.89 = whole+pointer 4.89 (same 3 compositions). | sceneInputMode = flattened. |
| T2b | Label binding | Rotated labels still scored 5/4/5 vs 5/5/5 - the image dominates its label. | Keep Element N labels for attribution; do not rely on them for binding. |
| T3 | Naming | **PASS** - >= 2 usable pins on 13/14 photos (bar 80%); 43 named, 40 usable; faceFlag exactly on the 2 synthetic-people photos. | elements.v1 + SAM per concept ships as slice 1 pipeline. |
| T4 | Speed | **PASS on mean** - photo->pins mean 10.6 s, max 17.2 s (bar <= 15 s; slowest photo breached a per-photo reading); scene mean 14.4 s, max 27.2 s (bar <= 30 s). | Timeouts: Spark 30 s, SAM 20 s, scene 120 s. Show pins incrementally. |
| T5 | Cost | **PASS (estimates)** - 0.020 USD/photo (bar <= 0.05), 0.022 USD/scene (bar <= 0.10); spike total est. 0.879 USD of 25 USD cap, 14/60 Higgsfield images, 116 logged calls. SAM bills 1 image per concept call (usage.images_processed=1). Muse Image USD use Spark rates as labelled proxy; dashboard authoritative. | Policy caps as proposed; verify USD on dashboard before PIN-55. |
| T6 | Refusals | **PASS** - 0/10 harmless prompts refused (3 with synthetic people). | faces: note holds; refusal stays friendly outcome. |

Transport facts locked: portrait 1024x1536 accepted (returns
1280x1920) -> sceneSize = 1024x1536; store: false accepted on
every compose call -> stateless remix; Spark element calls need
max_tokens 4000 (1500 starved reasoning).

## 9. Open questions (grilled Oct 28; defaults hold until overridden)

Each question carries a proposed default. None blocks PIN-49; the
owning issue in brackets decides or verifies.

1. **`store` / retention:** do we send `store: false` on
   `/v1/responses` and replay prior `image_generation_call` items,
   or accept server-side conversation state for `previous_response_id`
   chaining?
   **Default:** `store: false` everywhere; remix is stateless (§5.7).
   Privacy copy must say inputs go to Meta under Standard mode
   (not used for training), never "zero data retention". [PIN-51]
2. **SAM billing unit:** does each concept call bill as one image
   ($0.0025), or per matched instance? A photo with 6 elements is
   6 concept calls either way, but multi-instance matches could
   multiply.
   **RESOLVED (PIN-50):** one billable image per concept call (wire usage.images_processed=1). **Default:** budget as one billable image per concept call;
   PIN-50 confirms from `AiCallLog`/account usage before PIN-53 sets
   `elementsPerPhoto.max`. [PIN-50]
3. **Portrait size:** which portrait `size` values does the image
   tool accept (e.g. `1024x1536`)? Only `1536x1024` is documented.
   **Default:** `1024x1536` once verified; until then use the
   documented landscape size and letterbox in the card. Keep the
   value in Policy (`sceneSize`). [PIN-50]
4. **Hosted $2 budget:** hosted `AI_DAILY_BUDGET_USD=2` / 200 calls
   is too small for family play (A2). Raise to what, and what stops
   one board from spending the day's budget?
   **Default:** dev/prod $10/day + per-board caps
   (`scenesPerBoardPerDay` 40) + per-participant caps; Robin applies
   the env raise before PIN-55. Local spike money ($25, PIN-50)
   stays separate. [PIN-51 / PIN-55, operator]
5. **24 h TTL vs 14 d lifecycle:** Policy says
   `workingCopyTtlHours` 24, but the bucket rule deletes `tmp/`
   after 14 days (A6). Which is the real guarantee?
   **Default:** app deletes the working copy when pins are chosen
   (or at 24 h via a sweeper); operator tightens the lifecycle rule
   to 1 day as backstop. No 24 h claim in copy until both exist.
   [PIN-53 + operator]
6. **Slug validation:** a `%2F` slug reaches Firestore as a path.
   Validate at every route entry, or centrally in the repository?
   **Default:** reject anything not matching `^[A-Za-z0-9_-]{22}$`
   at the first server boundary of every `/g/{slug}` route (404,
   not 500), plus a unit test. Exactly 22 chars matches the current
   128-bit base64url generator. [PIN-51]
7. **Preset fate:** `docs/09` presets bundle a host persona with a
   look. The game is gone — keep, halve, or delete?
   **Default (A5):** looks become board themes (tokens + PIN-41
   art); personas are deleted in PIN-52. [PIN-52 / PIN-53]
8. **Demo-board seeding:** how is the judge demo board populated —
   synthetic pins committed as fixtures, generated live on first
   visit, or seeded by a script against prod?
   **Default:** synthetic elements + scenes committed as small
   fixtures under `eval/` rules, seeded by an idempotent script per
   environment; no live paid calls on judge traffic. [PIN-55]
9. **Faces copy:** `faces: note` shows "everyone in this photo OK
   with being remixed?" — dismissible per photo, per board, or
   once per participant?
   **Default:** once per photo containing a face; never blocking
   (§2). Refusals from the provider render as a friendly `refused`
   outcome. [PIN-53 / PIN-54]
10. **Chips:** suggestion chips generated per board (Spark, a paid
    call) or a fixed list?
    **Default:** fixed list in v1; generated chips only if slice 2
    lands with time to spare (cut order, §7). [PIN-54]

## 10. Context to load

- **Repo (`dev`):** `AGENTS.md`; `docs/06` (photo intake), `docs/07`
  (SAM lab), `docs/08` (UX principles), `docs/09` (themes),
  `docs/10` (domains); measurements in `docs/archive/02` and
  `docs/07`.
- **`src/server/`:** `photo-intake.ts`, `sam-mask.ts`,
  `segment-submission.ts`, `confirm-cutout.ts`,
  `derivative-store.ts`, `player-session.ts`, `rate-limit.ts`,
  `ai-usage.ts`.
- **`src/gateway/`:** `model-gateway.ts`, `meta-gateway.ts`,
  `mock-gateway.ts`.
- **External:** meta-models/meta-model-cookbook, folders
  `05_muse_image/01` to `04` and `07_sam`; the `@meta-sam/parser`
  README.

## 11. Clean-up

- Cancel the game-only backlog: PIN-11 and the M2 "Host + Memory"
  items (Robin).
- Look at the contact sheets in the morning review; override any
  threshold in a comment.
- README top section updated to Studio in PIN-49.
- Decide on Saturday whether the Discord board opens.

## 12. Issue map

| Issue | What | Blocked by | Executor |
| --- | --- | --- | --- |
| PIN-48 | Parent: Studio pivot hand-off | — | Muse Code |
| PIN-49 | Spec into the repo (`docs/11`, ADR-003), agent rules rewritten | — | Muse Code |
| PIN-50 | Slice 0: live spikes on synthetic images (§8) | — | Muse Code |
| PIN-51 | Policy and gateway foundations (§5.1–5.2) | PIN-49 | Muse Code |
| PIN-52 | Delete the game code, rename routes to boards | PIN-49 | Muse Code |
| PIN-53 | Slice 1: photo → elements → pins | PIN-51, PIN-52 | Muse Code |
| PIN-54 | Slice 2: pins → scene | PIN-50, PIN-53 | Muse Code |
| PIN-55 | Slice 3: friends, sharing, demo board, prod | PIN-54 | Muse Code |
| PIN-56 | Slice 4: remix, tap-to-add, delete my element | PIN-54 | Muse Code |
| PIN-57 | Sign-in behind `AUTH_MODE` (later) | PIN-53 | Muse Code |
| PIN-58 | Family-and-friends launch, usage for the video | PIN-55 | Robin |
