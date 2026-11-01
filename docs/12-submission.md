# 12 — Submission packet (PIN-81)

_Status: freeze-prep packet, Oct 29, 2026, refreshed Oct 31
(PIN-219). Feature freeze Tue Nov 3, 2026 (end of day);
submission due Wed Nov 4, 2026, 9:00 PM ET (`docs/11-studio.md`
§1, `README.md`). Robin records the video and submits; this file
only prepares it. It contains no board link, slug, or secret —
board links are capability secrets (`README.md`, "Try it"), so
every board URL below is a placeholder to fill in from private
notes (the PIN-81 tracker entry) at record/submit time, never
committed._

Every feature and number claim here was verified against `dev`
code and docs on Oct 29, 2026 (see §3 for the source of each
number). The Oct 31 refresh re-checked tap-add naming, UI labels,
models, budgets and the TTL story; test and PR counts are marked
"recount at freeze". If code and this packet disagree at freeze,
the code wins — re-run §4 and the test command before submitting.

Nov 1 refresh (PIN-235): §2 now holds the chosen video direction
and the overnight prototype (the older 170 s storyboard is in git
history); §7 adds the event's rules and judging brief with sources;
§8 maps the submission form's fields.

## 1. One-page pitch

**Pinneds Studio — your stuff, pinned together.**

Anyone with the board link uploads a photo. Muse Spark names
the things in it, SAM 3.1 cuts each one out, and the cut-outs
are pinned to the board with the owner's name. Anyone then
picks 1–4 pins from anyone (Policy `pinsPerScene`,
`src/policy/policy.ts`), writes, dictates (Muse Voice) or taps
an idea chip, and Muse Image composes them into a new image in
the board's gallery — credited to the people whose things are
in it. Any
scene can be remixed statelessly (parent scene image plus new
pins as references, `store: false`). A pin's owner can delete
their element; its pins go and scenes that used it are hidden.
No sign-up needed: the link is the invitation. Optional
Google sign-in adds a personal library (My boards, My pins)
without ever gating the loop. The UI comes in seven languages.
Solo works too.

Why it matters (*Build for Your World*): group chats are full
of photos of real things — a mug, a cat, a weird lamp. Pinneds
turns those into a shared toy: your friends' actual things,
remixed together, in under a minute, with credit kept. Four
Meta models at runtime (Muse Spark, SAM 3.1, Muse Image, Muse
Voice) and one at build time (Muse Spark Open, which translated
the UI) each do the job they are best at (see §6), behind one
typed Policy object and a fail-closed budget decorator, so the
demo that ships is also the system that is safe to hand to
family.

### Links block (fill in at submit time — do not commit real values)

| Link | Value |
| --- | --- |
| Repository (public, AGPL-3.0) | https://github.com/MoriaCrew/Pinned |
| Deployed product (prod) | https://pinneds.com (live from Nov 1; `<PROD_URL>` below means this) |
| Demo board (from the PIN-81 tracker entry; never commit) | `<DEMO_BOARD_URL from Linear>` |
| Pitch video (~3 min, §2) | `<VIDEO_URL>` |
| Dev backend (live models; the only live demo before Nov 1) | https://dev.pinneds.com |

Notes for whoever fills this in:

- `<PROD_URL>`: https://pinneds.com from the Nov 1 promotion
  (`docs/DEPLOY.md`). Do not submit it until it has been opened
  and played end-to-end; if prod is not ready, submit the dev URL
  and say so.
- `<DEMO_BOARD_URL from Linear>`: paste it only into the
  submission form and the video description. It must never be
  committed to this repo or shown in the video (§2, capture
  notes).
- `<VIDEO_URL>`: the unlisted/public host URL of the §2 cut.
- The submission form has no field for the product URL or a
  demo board (§8). `<PROD_URL>` and `<DEMO_BOARD_URL from Linear>`
  go into the Project Description text, and the description is
  the only place the demo board link appears.

## 2. Video: direction, prototype and capture rules

The video is the artifact judges watch twice: Stage 2 scores it
next to the code and the live product, and the Stage 3 finalists'
videos are watched live (§7). Limit: three minutes; target 2:50.

### Direction (chosen Oct 31)

Story **"Made from"**: a friend group's Halloween. Their real
things become pins, and anyone mixes anyone's pins into a new
scene that says whose things are in it, and that the owner can
take back. Each step names the Meta model doing it on screen
(Muse Spark names, SAM 3.1 cuts, Muse Voice Transcribe takes the
idea, Muse Image composes; the UI languages came from Muse Spark
Open). The business is one short beat (free to play, Board Plus
€2.99 once per board, guests never pay), not the story.

Rules for every cut:

- **Never fake the product.** Every shot of the app working is a
  real recording of the real app. AI-generated story shots show
  the people and places only: no phone screen in a generated shot
  may show an interface (re-roll the shot if it does).
- **Mark every edit of a model wait.** A shortened wait or a
  sped-up clip carries an on-screen note ("real scene wait 27 s,
  shortened").
- **Disclose on the end card:** which shots are AI-generated
  (Higgsfield) and where the app footage was recorded.
- **Synthetic people and things only.** The cast and the photos
  of their things are generated; no real faces, no board link on
  screen, no slug in any file name or log.

### Prototype (Nov 1)

A 66 s cut was produced overnight to test the approach:

- six story shots (GPT Image 2.5 stills from one cast anchor,
  animated with Kling 3.0 pro);
- real recordings of dev.pinneds.com with live models: four
  people, ten pins, two scenes (the hero scene and a remix),
  dictation transcribed by Muse Voice Transcribe from a fake
  microphone fed with a generated voice;
- narration in two candidate voices (Seed Audio), captions, an
  end card in the app's own fonts.

Cost: 198.2 Higgsfield credits including a five-model video
comparison (≈ 110 for the cut itself) and ≈ $0.22 of Meta Model API
calls on dev. The throwaway board was deleted afterwards through the
app. The storyboards, findings, model comparison, cut lists and
scripts live in the private video repository `MoriaCrew/Pinneds-Video`
(PIN-236), with media kept outside git.

Open before the three-minute cut: narrator voice, music (no
standalone music model is available on the Higgsfield account),
the story structure (pre-party in separate places, then the party,
the late arrival and the close), and re-recording the app on
`<PROD_URL>` after the promotion.

### Capture rules (app footage)

- Scripted capture at a phone viewport (390x844 CSS px at 3x,
  1170x2532 frames, 30 fps) through a CDP screencast; Chromium
  needs `--force-device-scale-factor=3` for sharp frames. Only
  overlay: a touch dot at each tap.
- Each person is a separate browser context joining by the board
  link; one context per language where the language matters.
- The board link lives only in a private file outside the repo;
  scripts sanitise every log line. The app never renders the link
  as text, and page-only frames carry no address bar.
- Real waits seen: photo to pins 13–17 s, scene 17–27 s,
  transcript ~4 s. Hold dictation at least 12 s: a headless
  recorder can stop early and cut the sentence.
- Record on the submitted host (`<PROD_URL>` after the Nov 1
  promotion). Delete throwaway boards afterwards through the app.

## 3. Evidence table (every number with its source)

Costs are **labelled estimates**, never bills (see notes).
"Oct 29 live run" means re-measured by the agent against
`dev` for this packet; spike numbers are PIN-50 live runs on
synthetic images.

| Claim | Value | Source |
| --- | --- | --- |
| Scene fidelity (T1) | **4.86 / 5** mean over 14 elements in 5 flattened scenes; every element ≥ 3 in 5/5 scenes. Spark-as-judge is a proxy; contact sheets are the human check. | `eval/studio-findings.md` (T1); summarised in `docs/11-studio.md` §8 Findings |
| Input mode (T2) | Flattened 5.00 > transparent 4.89 = whole+pointer 4.89 (same 3 compositions) → Policy `sceneInputMode: flattened` | `eval/studio-findings.md` (T2); `src/policy/policy.ts` |
| Naming (T3) | ≥ 2 usable pins on 13/14 photos (bar 80%); 43 named, 40 usable; faceFlag exactly on the 2 synthetic-people photos | `eval/studio-findings.md` (T3); `docs/11` §8 |
| Photo → pins time (T4, spike) | Mean **10.6 s**, max 17.2 s per photo (bar ≤ 15 s: pass on mean, slowest photo breached a per-photo reading) | `eval/studio-findings.md` (T4) |
| Scene compose time (T4, spike) | Mean **14.4 s**, max 27.2 s over 25 ok scenes (bar ≤ 30 s) | `eval/studio-findings.md` (T4) |
| Photo → pins, hosted dev (PIN-67 live run, Oct 29) | 3 synthetic fixtures, 12.6 / 11.0 / 16.1 s upload→ready (mean 13.2 s); all 9 candidate pins confirmed | `eval/studio-findings.md` (PIN-67 section) |
| Cost per photo (T5, **estimate**) | **≈ $0.020**/photo (bar ≤ $0.05). SAM bills one image per concept call (`usage.images_processed=1`); provider dashboard is authoritative | `eval/studio-findings.md` (T5); `docs/11` §8 |
| Cost per scene (T5, **estimate**) | **≈ $0.01**/scene (bar ≤ $0.10). Meta's published Muse Image price is a flat $0.01 per generated image, whatever the tokens; the PIN-50 spike had priced tokens at Spark rates (≈ $0.022). Provider dashboard is authoritative | `src/gateway/costs.ts`; `docs/16-ai-usage.md`; `eval/studio-findings.md` (T5) |
| Refusals (T6) | 0/10 harmless prompts refused (3 with synthetic people) | `eval/studio-findings.md` (T6) |
| Automated tests | **1,507 passed / 2 skipped** (133 files), `AI_MOCK=1`, as of Oct 31, 2026 on `dev` (tip `f010eb7`). **Recount at freeze**; CI never makes paid calls | `npm test` (`package.json`); CI config `.github/workflows/ci.yml` |
| Pull requests | **203 merged** (212 opened) as of Nov 1, 2026 — a moving number; **recount at freeze** (command below) | `gh pr list --state all --limit 500` |
| Repo public | `MoriaCrew/Pinned`, visibility PUBLIC, AGPL-3.0 | `gh repo view` (Oct 29); `LICENSE`, `README.md` |
| UI languages | Six translated by Muse Spark Open plus a reviewer pass; first pass **$0.98** in total. No native-speaker review yet | `docs/18-i18n.md` ("Costs", "Who reviewed what") |
| Usage (people / pins / scenes) | Not a fixed number — captured fresh per §4 on record and submit days | `scripts/usage-report.mjs` (`npm run usage:report`) |

Recount PRs at freeze (before the video end card or any
"built in N PRs" line is finalised):

```bash
gh pr list --state all --limit 500 --json number,state
gh pr list --state merged --limit 500 --json number
```

Policy values quoted in §1–§2 (`pinsPerScene` 1–4,
`elementsPerPhoto` 1–6, `boardPollIntervalMs` 5000, timeouts
30 s / 20 s / 120 s, `faces: note`, `sceneStore: false`,
models `muse-spark-1.3` / `sam-3.1` / `muse-image-1.0` /
`muse-voice-transcribe-1.0`) are
the defaults in `src/policy/policy.ts` — one object the UI,
validators and prompts all read (`docs/11` §5.1).

## 4. Usage capture (the numbers on the end card and in the form)

The report reads the **public boards API only** — there is no
board list by design, because slugs are capability secrets —
so you name the boards to count. Slugs are passed locally and
are **never printed** by the script (output is board titles +
counts) and must **never be committed**
(`scripts/usage-report.mjs` header, PIN-74).

Steps (Robin or agent, on record day and again before
submitting):

1. Decide the base URL: the deployed host the real boards live
   on (`USAGE_BASE_URL`; falls back to `SEED_BASE_URL`, then
   `http://localhost:3000`).
2. Gather the board slugs from private notes (the same place
   `<DEMO_BOARD_URL from Linear>` lives). Do not paste them
   into any tracked file, shell history you plan to share, or
   the video.
3. Run (exact command from `package.json`):

   ```bash
   # slugs as arguments…
   USAGE_BASE_URL=<PROD_URL> npm run usage:report -- <slug> [<slug> ...]
   # …or via env:
   USAGE_BASE_URL=<PROD_URL> USAGE_BOARD_SLUGS=slug1,slug2 npm run usage:report
   ```

   (Windows PowerShell: set `$env:USAGE_BASE_URL` /
   `$env:USAGE_BOARD_SLUGS` first, then run the npm command.)
4. Read the per-board lines (`title: people=… elements=…
   pins=… scenes=…`) and the final `TOTAL:` line. Those are
   the end-card / submission numbers. Date-stamp them wherever they
   are quoted ("as of Nov 4").
5. If a board 404s or returns malformed counters, the script
   reports it on stderr, excludes it from totals, and exits 1
   — totals are never invented. Fix the slug/host and re-run
   rather than quoting a partial total as complete. No slugs
   at all exits 2.
6. Save the output privately next to the slugs (not in the
   repo). The repo-side logic it mirrors is
   `src/domain/usage-report.ts`.

## 5. Freeze checklist (Nov 3 freeze → Nov 4, 21:00 ET submit)

Deadline: **Wed Nov 4, 2026, 9:00 PM ET** (03:00 Nov 5 Paris)
— `docs/11` §1. Feature freeze: **Tue Nov 3, end of day**.
Owner legend: **Robin** = human only; **Agent** = Muse
Code can do it end-to-end via the normal `PIN-*` PR-to-`dev`
flow; **Robin + Agent** = agent prepares, Robin decides or
approves.

### Before / at freeze (Nov 3)

| # | Item | Owner | Done when |
| --- | --- | --- | --- |
| F1 | Feature freeze declared: no new feature slices after Nov 3 EOD; only freeze-blocking fixes | Robin | Date reached; any later change is a stated exception |
| F2 | `dev` green end-to-end: `npm run typecheck`, `npm test` (`AI_MOCK=1`), `npm run build` (exact gates from `package.json`) | Agent | All three pass at the freeze commit; test count updated in §3 if it moved |
| F3 | Prod promotion: `dev` → `main`/prod per the hosting setup, then a real end-to-end play on `<PROD_URL>` (create board → pin → scene → remix → share → delete) | Robin + Agent (Robin owns promotion/approval; agent must never push `main`/prod itself) | `<PROD_URL>` plays the full loop with live models; `/api/health` answers |
| F4 | Demo board seeded on the submit host (`npm run seed:demo`; slug recorded privately, `DEMO_BOARD_SLUG` set in host env if the landing demo link is wanted) | Agent prepares, Robin approves host/env changes | `<DEMO_BOARD_URL from Linear>` opens a populated, non-empty board |
| F5 | Hosted budget sanity: confirm the deployed `AI_DAILY_BUDGET_USD` / call limit env values are sized for judge + family traffic (`docs/11` A2: code default $5 / 500 calls, dev the same; prod $50 / 10,000 during judging per Robin, Oct 31, see `docs/DEPLOY.md`; verify the live values, do not assume) | Robin | Live values checked in the hosting env and matching A2 |
| F6 | This packet refreshed: §3 test count + PR count re-run at the freeze commit, §1 links block placeholders assigned owners | Agent | Packet matches freeze-commit reality |
| F7 | Known-v1-limits honesty pass on `README.md` + this file (1-day `tmp/` lifecycle backstop applied vs the app-side delete, cost-estimate labelling, optional sign-in scope, non-Meta Higgsfield assets disclosed) | Agent | No claim in the packet or README that the code doesn't back |

### Video (Nov 3–4)

| # | Item | Owner | Done when |
| --- | --- | --- | --- |
| V1 | Record the app clips with the §2 capture rules on `<PROD_URL>`; generate the story shots per the storyboard in the video repository | Robin + Agent | Every app clip and story shot in the cut list exists; no slug in any frame or file name |
| V2 | Fresh usage numbers captured per §4 on record day → end card | Robin (agent can run the command if given the host) | End-card numbers are dated, real, and reproducible |
| V3 | Edit to ≤ 3:00 (~170 s target) with the video repository's build script; every shortened wait marked on screen; end card discloses AI-generated shots | Robin + Agent | Final cut plays start-to-finish; every shown feature exists on the submitted build |
| V4 | Upload video; put repo + `<PROD_URL>` in the description; the demo board link **only** if the submission rules ask for it there — never in the repo | Robin | `<VIDEO_URL>` resolves and is viewable without login |

### Submit (Nov 4, before 21:00 ET)

| # | Item | Owner | Done when |
| --- | --- | --- | --- |
| S-1 | Repository public (already PUBLIC Oct 29, §3) — re-confirm, and confirm no board slug/secret ever landed in tracked files (gitleaks history is the backstop) | Agent verifies, Robin owns repo settings | `gh repo view` = PUBLIC; secret scan clean |
| S-2 | Deployed product URL in the submission form = the played-and-verified `<PROD_URL>` (F3), not dev, unless prod genuinely isn't ready — in which case submit the dev URL and say so honestly | Robin | Form URL opened in a fresh browser plays the loop |
| S-3 | Demo board link pasted into the submission form from the tracker entry (`<DEMO_BOARD_URL from Linear>`) | Robin | Judge can open a populated board with no sign-up |
| S-4 | `<VIDEO_URL>` pasted; pitch text from §1; numbers from §3/§4 with estimate labels intact | Robin (text from this packet) | Form reviewed against §3 — no unlabelled cost claim |
| S-5 | Submit before 21:00 ET, then screenshot/save the confirmation privately | Robin | Confirmation saved; packet placeholders can now be filled in private notes |

## 6. Judging Q&A prep

Short, honest answers. Each is backed by code or docs as
cited; where v1 has a limit, say the limit first.

**"What happens to my original photo?" (privacy)**
The original upload is never stored. It is stripped (EXIF
removed, re-encoded) into a short-lived working copy under
`tmp/` so tap-to-add can re-prompt SAM; only cut-outs
(`elements/`) and scenes (`scenes/`) persist, served through
routes that check the board link, with client storage rules
deny-all (`docs/06-photo-intake.md`, `docs/11` §5.5). The app
deletes the working copy when the uploader taps "Pin selected"
and sweeps any copy older than Policy `workingCopyTtlHours`
(24) on the board's next upload or confirm; the bucket rule in
`storage.lifecycle.json` (1 day from PIN-209) is the backstop.
The sweep is opportunistic, not a cron, so we say "deleted when
you pin" and make no hard 24-hour promise (`docs/11` A6).
Dictated audio is never stored either.

**"Who can see a board?"**
Only people with the link. Slugs are 128-bit base64url
(`^[A-Za-z0-9_-]{22}$`) validated at every board route before
any data path is built; there is no board directory and no
listing API — even our own usage report must be handed the
slugs (§4). Identity on a board is a signed participant
cookie. Optional Google sign-in (`AUTH_MODE=optional`, live
on dev; PIN-57, `docs/13-auth.md`) links a participant to a
user library but never replaces the link: the slug is still
required to reach any board, and My boards lists only boards
the user already joined by link. Board pages are `noindex`.

**"People in photos?"**
Allowed, never blocked. When Spark flags a face, the app
shows one line ("There's a face in this photo. Pin it if
they're happy to be here.") and proceeds either way (Policy
`faces: note`).
The provider's guardrails refuse what they refuse; a refusal
is a typed, friendly outcome in the UI, never an error page.
A tap-added cut-out is named by Spark from its crop, with a
face flag, so a tapped person triggers the same note (PIN-117,
`src/server/decompose-job.ts`); only if that pass fails does it
keep the label "My find" and no flag.

**"Is my data used for training / retained by Meta?"**
Inputs go to Meta under Standard mode — not used for
training. Compose calls send `store: false` and remix
re-attaches the parent image as a reference instead of
chaining server-side conversation state. We deliberately
make **no** "zero data retention" claim (`docs/11` §4, §9 Q1).

**"What does it cost, and what stops a runaway bill?" (cost
guardrails)**
Estimates, labelled as such: ≈ $0.020 per photo in the PIN-50
spike and ≈ $0.01 per scene (Muse Image's flat list price per
generated image) — the provider dashboard is authoritative
(§3). Guardrails are structural, not
aspirational: every model call runs one decorator chain —
timeout → single retry on 429/5xx → **reserve daily budget,
fail closed** → call → log cost (`src/gateway/decorators.ts`,
`budget.ts`, `costs.ts`). Policy caps the fan-out:
`elementsPerPhoto` ≤ 6, `pinsPerScene` ≤ 4,
`photosPerParticipantPerDay` 20, `scenesPerParticipantPerDay`
10, `scenesPerBoardPerDay` 40 (`src/policy/policy.ts`), plus
env-set daily USD/call ceilings (F5 verifies the live hosted
values). CI runs on `AI_MOCK=1` and never spends.

**"Why Meta's models — couldn't any vision/image API do
this?"**
Each model does the job the product is built around.
**Muse Spark** turns a photo into short noun phrases SAM can
actually use (plus face flags and scene-suggestion chips) —
naming *for segmentation*, not captioning. **SAM 3.1** gives
both concept prompts ("cut out the brass lamp") and point
prompts (tap-to-add) in one Segmenter port, billing one image
per concept call — that pair is the pin interaction.
**Muse Image** composes *several reference images* into one
scene via `/v1/responses`, which is the whole product: real
things from different people in one new image, recognisably
themselves (T1 fidelity 4.86/5, §3) — and `store: false`
makes remix stateless. **Muse Voice Transcribe** turns a
spoken idea into the scene prompt (short clip, audio never
stored). **Muse Spark Open** on Baseten ran at build time only:
it translated and reviewed the UI into six languages, and the
app never calls it. The gateway hides the runtime models
behind six capability ports (`ElementNamer`, `Segmenter`,
`SceneComposer`, `ChipSuggester`, `TapNamer`,
`SpeechTranscriber`) with mock and recorded-fixture adapters,
so the offline test suite (§3, recount at freeze) never spends
and a model swap is an adapter, not a rewrite
(`docs/adr/003-studio-architecture.md`).

**"How was fidelity measured?"**
Five composed scenes, 14 elements scored 0–5 against their
cut-outs by a Spark vision judge — mean 4.86/5, with contact
sheets saved for human review because an LLM judge is a
proxy, not ground truth (`eval/studio-findings.md`, T1/T2).

**"Is everything made with Meta models?"**
Everything the app does at runtime is. Not every shipped
image is: the older landing showcase set, the `/start`
samples and the theme art are Higgsfield images (SAM cut the
landing cut-outs). The newer showcase sets were made end to
end with Muse Image and this app (`docs/17`,
`public/landing/README.md`).

**"What breaks / what's next?"**
SAM returns no match for some named things (those simply
don't become pins; tap-to-add is the workaround). The
1-day lifecycle backstop (PIN-209), estimate-only costs and
no native-speaker review of the translations are the stated
limits. Optional sign-in (PIN-57) shipped — elements follow
their owner via the My pins library, as the owned `Element` /
board `Pin` split anticipated (`docs/11` §5.4). Next: iterate
on real family feedback.

## 7. Rules and judging brief (read Oct 31, 2026)

Sources: the participant guide (**G**,
https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details),
the Official Rules on the event waiver page (**R**,
https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
and the event overview (**O**,
https://cerebralvalley.ai/e/meta-ai-developer-hackathon).

| Topic | What it says | Source |
| --- | --- | --- |
| Deadline | Wed Nov 4, 9:00 PM ET, through the Cerebral Valley portal; late entries are not considered | G §3, §7; R |
| Video | "a three minute demo video highlighting the specific features, code, and functionality you built during the Hackathon"; a primary judging artifact with the code and the live product | G §7 |
| Repository | Must be public; repo and video links must open without login; everyone who worked on it is listed | G §4, §7 |
| New work | Judges must be able to tell what was built during the event; failing to identify it means "immediate disqualification" | G §4 |
| Rights | No code, data or assets without rights; the entry is original and infringes no copyright, privacy or other rights; open source allowed under its licence | G §4; R "Hackathon Submission" |
| Licence to organisers | Perpetual, non-exclusive, royalty-free, including marketing use | R |
| Stage 1 | Pass/fail: fits the theme and reasonably uses the Meta Model API and/or Meta open-weight models | G §8 |
| Stage 2 | 0–10 per criterion: **Impact 30 %**, **Use of Meta AI Tooling 25 %**, **Technical Depth & Execution 20 %**, **Demo 25 %** ("does the product hold up live? Is the demo video genuinely cool to watch?") | G §8; R |
| Stage 3 | Top 5 per track; final judges watch the videos live and rank with the same rubric; closing ceremony Mon Nov 9, 12:00 PM ET | G §3, §8 |
| Indie track | "Judged on creativity, technical ambition, and whether it works" | O |
| Theme | Build for Your World: "Solve a problem you know firsthand … make something possible that wasn't before" | G §1 |
| Bonus prizes in reach | Best Creative Build ($5K, Muse Image or Muse Wonder); Most Viral ($20K, an X post, engagement counted to Nov 8 EOD, link in the form); Community Vote ($10K) | G §9 |
| Anti-projects | Includes "Simple Image Analyzers": the video must not open on photo → labels | G §4 |

Risks for Pinneds and how we answer them:

1. **New work.** The repository's first five commits (Oct 26,
   10:43–11:40 ET) came before the 12:00 ET kickoff and hold only
   the licence, planning docs and secret-scanner configuration; the
   app scaffold landed at 15:09 ET. Say so in the README and in one
   line of the video.
2. **The product must hold up live.** A judge's new board gets the
   free tier; the demo board holds a fixed number of AI scenes once
   Plus is bought; judges behind one shared office address share the
   free-board allowance while signed out (`docs/15`). Size the demo
   board's headroom for judging week before Nov 4.
3. **Claims must match the repo.** Four Meta models at runtime and
   one at build time; Muse Code is a coding agent, not a model in
   the product; cost figures are estimates.
4. **Rights.** Music needs licence evidence; generated story media
   keeps its job ids (cost log in the video repository); no real faces; no board link in any
   frame.

## 8. Submission form fields (read Oct 31, 2026)

The form is a side panel on the event page (sign-in required).
Starred fields are required.

| Field | Answer from |
| --- | --- |
| Team Name * | team name |
| Team Members | pre-filled with the submitter; solo entry |
| Track * | Indie Developer Track |
| Problem statement * | Build for Your World |
| Most Viral: X post link | the X post of the short cut, if posted before submitting |
| Project Description * | §1 pitch + `<PROD_URL>` + `<DEMO_BOARD_URL from Linear>` (no other field takes a URL to the product) |
| Public GitHub Repository | https://github.com/MoriaCrew/Pinned |
| 3-Minute Demo Video | `<VIDEO_URL>` (the placeholder suggests YouTube) |
| Use of Meta products to build the project | `docs/19-meta-models.md` summary |
| Why Meta's models are important | §6 "Why Meta's models" |
| Partner technology feedback | Baseten (Muse Spark Open for the UI translations) |
| Survey items (Meta Model API, Muse Code, obstacles, comparisons) | the submitter's own answers |
| Consent checkbox (use, publish, share …) | read in full before ticking |
