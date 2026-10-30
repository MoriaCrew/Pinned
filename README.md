# Pinneds Studio — a shared pinboard of real things

> Anyone with the board link uploads a photo. Muse Spark names the
> things in it, SAM 3.1 cuts each one out, and the cut-outs are pinned
> to the board with the owner's name. Anyone then picks a few pins
> from anyone, writes or taps a scene prompt, and Muse Image composes
> them into a new image in the board's gallery — credited to the
> people whose things are in it. No sign-up needed: the link is
> the invitation. Signing in with Google is optional and adds a
> personal library (your boards and pins, on every device).

**Meta Global AI Developer Hackathon** · Indie Developer track · Theme:
*Build for Your World* · Solo developer · Oct 26 – Nov 4, 2026

- Hackathon: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details
- Meta event page: https://dev.meta.ai/events/global-hackathon
- Repository: https://github.com/MoriaCrew/Pinned (public, AGPL-3.0 — see License below)

## Studio in 30 seconds

1. **Share.** Create a board, get a link (`/g/{slug}`), drop it in the
   group chat. Nothing to install, no sign-up.
2. **Pin.** Anyone uploads a photo; Spark names the things in it and
   SAM cuts them out. The cut-outs land on the board as pins with the
   owner's name. Tap the photo in the Add sheet to cut out something
   naming missed (PIN-78).
3. **Make a scene.** Pick 1–4 pins from anyone (Policy
   `pinsPerScene`), write a prompt or tap a suggestion chip, and Muse
   Image composes them into a new image in the board's gallery —
   credited to whoever brought each thing.
4. **Remix.** Any scene can be remixed: the parent scene image plus
   any new pins go back to Muse Image as references, statelessly
   (`store: false`; PIN-79). Credits carry the full contributor set.
5. **Rename or delete.** A pin's owner can rename their own thing
   (More, Rename; up to Policy `elementLabelMaxChars`; credits and
   scenes show the new name, PIN-157) or delete it; its pins go and
   scenes that used it are hidden (PIN-77).
6. **Your library (optional).** Sign in with Google and the boards
   you join and the cut-outs you pinned follow you: *My boards*
   lists them, *My pins* is your cut-out library, and any of your
   pins can be pinned onto another board you belong to (PIN-57).
   Signing in never gates the loop above — the board link is
   still the only key to a board.

## Try it

### Hosted dev (live models)

Open **https://dev.pinneds.com** in a browser.

- **Make your own board:** use the Start action on the landing page
  (it goes to `/new`). Create the board, then copy the board URL
  from your browser's address bar and share that link — anyone with
  it can join, pin photos and make scenes. Board links are
  capability secrets, so this README intentionally contains no board
  link or slug.
- **Join someone else's board:** open the board link they sent you.
  There is no board directory and no sign-up; if you don't have a
  link, ask the board's owner for one or start your own board above.
- When a seeded demo board is configured on the host, the landing
  page also shows a demo action that opens it; if it's absent, just
  create a board — solo works too.

Status as of Oct 29, 2026: the dev backend above is the live demo.
Prod (`pinneds.com`) promotion is still pending (see Known v1 limits).

### Local, offline with mock AI (no API key)

Requirements: Node 20.9+ and npm. `.env.example` defaults to
`AI_MOCK=1` and the in-memory data backend, so the full flow —
boards, pins, mock scenes — runs with no API key and no paid calls.

```bash
git clone https://github.com/MoriaCrew/Pinned.git
cd Pinned
npm install
cp .env.example .env.local   # PowerShell: Copy-Item .env.example .env.local
npm run dev
```

Open http://localhost:3000 in a browser. Health check:
http://localhost:3000/api/health

To run against live models locally instead, set `AI_MOCK=0` and a
real `META_API_KEY` in `.env.local` (never commit it; see
`.env.example` and `SECURITY.md`).

## How Meta's models power it

| Model | Role in Pinneds Studio |
| --- | --- |
| **Muse Spark** (`muse-spark-1.3`, Meta Model API) | Names the elements in a photo (short noun phrases that feed SAM), flags faces for the one-line consent note, and writes generated scene-suggestion chips. |
| **SAM 3.1** (`sam-3.1`, Meta Model API) | Cuts each named thing out of the photo: concept prompts, plus tap (point) prompts to add what naming missed. |
| **Muse Image** (`muse-image-1.0`, Meta Model API) | Composes selected pins into a new scene from reference images (`/v1/responses`); stateless remix re-attaches the parent scene image as a reference. |

Model IDs, prompt versions, timeouts and caps are Policy values
(see Architecture), not literals scattered through the code.

## Architecture map

Start with `docs/11-studio.md` (product spec, §5 architecture) and
`docs/adr/003-studio-architecture.md` (ADR-003). The code follows
them directly:

- **Policy as data** — `src/policy/policy.ts`: one typed Zod
  `Policy` (defaults in code, then env `POLICY_OVERRIDES_JSON`, then
  per-board overrides). It owns every count, size, cap, timeout and
  TTL — e.g. `elementsPerPhoto` 1–6, `pinsPerScene` 1–4, `faces:
  note`, `sceneInputMode: flattened`, `sceneSize: 1024x1536`,
  Spark/SAM/scene timeouts 30 s / 20 s / 120 s. Prompts, validators
  and the UI all read the same object.
- **Capability ports + decorators** — `src/gateway/`: the only AI
  surfaces are `ElementNamer`, `Segmenter` and `SceneComposer`
  (`ports.ts`), each with a Meta adapter (`meta-ports.ts`), a mock
  adapter (`mock-ports.ts`) and a recorded-fixture adapter
  (`fixture-ports.ts`). Every call runs one decorator chain
  (`decorators.ts`): timeout → retry on 429/5xx → reserve daily
  budget, fail closed (`budget.ts`) → call → log cost (`costs.ts`).
  A provider refusal is a typed `refused` outcome with a friendly
  line — never a 500.
- **Jobs, request + poll** — `DecomposeJob` (photo → pins) and
  `SceneJob` (pins → scene) move
  `pending → running → ready / failed / refused`, idempotent by job
  id with claim-before-call (`src/server/decompose-job.ts`,
  `src/server/scene-job.ts`). The request does the work; the board
  page polls with TanStack Query. There is no queue in v1.
- **Routes** — pages: `/` (landing), `/new` (create a board),
  `/g/{slug}` (the board), `/me/boards` + `/me/pins` (signed-in
  library). API under `src/app/api/boards/`: board create/view/
  delete (host only),
  `photos` (upload → decompose), `pins/confirm`,
  `pins/from-library`, `claim`, `jobs/{jobId}` +
  `jobs/{jobId}/tap-add`, `scenes` (+ scene image),
  `elements/{elementId}` (`DELETE` = delete my element), `chips`;
  sign-in under `/api/auth/session` + `/api/me*`; plus
  `/api/health`. Every board route validates the slug
  (`^[A-Za-z0-9_-]{22}$`, 128-bit base64url) before any data path
  is built.
- **Data model** — an owned `Element` (cut-out), a `Pin` placing it
  on a `Board`, and a `Scene` crediting its `elementIds`
  (`docs/11` §5.4). Optional sign-in adds a minimal user profile
  (`users/{uid}`: display name + photo, never email) and a
  per-user board index (`docs/13-auth.md`). Hosted data is
  Firestore; local dev defaults to the in-memory backend
  (`DATA_BACKEND=memory`).

### Storage and privacy

- Original photos are never stored: uploads are stripped (EXIF
  removed, re-encoded) into a short-lived working copy under `tmp/`;
  only cut-outs (`elements/`) and scenes (`scenes/`) persist, served
  through routes that check the board link. Client storage rules
  stay deny-all (`docs/06-photo-intake.md`).
- Honest TTL note: Policy sets `workingCopyTtlHours` to 24, but the
  bucket lifecycle backstop in `storage.lifecycle.json` currently
  deletes `tmp/` at 14 days — so don't read the working copy as a
  hard 24-hour deletion guarantee yet (`docs/11` §5.5, A6).
- People are allowed in pins — when Spark flags a face
  (`faces: note`) the app asks "everyone in this photo OK with being
  remixed?" and never blocks; the provider's guardrails refuse what
  they refuse, and refusals show as a friendly message, not an error.
- Inputs go to Meta under Standard mode (not used for training).
  Compose calls send `store: false`; there is no "zero data
  retention" claim.

## Testing

CI (`.github/workflows/ci.yml`) runs with `AI_MOCK=1` — it never
makes paid model calls. Quality gates, exactly as in `package.json`:

```bash
npm run typecheck
npm test
npm run build
```

Live on Oct 29, 2026 at `dev` commit `fc406c9`: `npm test` under
`AI_MOCK=1` reports **408 passed / 1 skipped** (56 files). Live-model
checks run on demand only, with cost logged (`docs/11` §5.9, §8).

Operator scripts (also in `package.json`): `npm run seed:demo`
creates one synthetic demo board through the public boards API and
prints its slug once — record it privately, never commit it; setting
`DEMO_BOARD_SLUG` in the host env turns on the landing demo link.
`npm run usage:report -- <slug> [...]` prints per-board
people/elements/pins/scenes counts, and `npm run usage:costs`
prints per-board estimated AI costs (slugs are passed locally only,
or printed hashed, never committed).

Billing (makes credits; design in `docs/15-board-plus.md`): modes are
`PLUS_MODE=off|mock|stripe` — `off` sells nothing (the default, and
prod), `mock` is the no-money demo, `stripe` sells credit packs via
hosted Checkout with webhook-only grants. The dev backend runs
`stripe` against the pinneds-dev **sandbox** since PIN-153 (including
`Policy.credits.enabled`, which defaults off in code). Operator
scripts: `npm run seed:stripe-catalog` converges a sandbox onto the
committed catalog (dry-run unless `--apply`);
`npm run billing:webhook-endpoint` ensures the dev webhook endpoint
and stores its signing secret in Secret Manager without printing it;
`npm run billing:reconcile` is the read-only paid-vs-granted report
(exit 1 on anomalies — runbook in `docs/15-board-plus.md`). Keys come
from env var names / Secret Manager only, never from git.

## Known v1 limits (status Oct 29, 2026)

- **Tap-to-add labels.** A tapped cut-out is named by a Spark crop
  pass (PIN-117, `prompts/tap-name.v1.md`): a real label and
  `faceFlag`, so a tapped person gets the face consent note. The
  generic label "My thing" remains only as the typed fallback.
- **Costs are estimates.** Spike figures of about $0.02 per photo
  and $0.02 per scene are estimates from `docs/11` §8 (T5); Muse
  Image dollars used Spark rates as a labelled proxy. The provider
  dashboard is authoritative.
- **Optional sign-in, link-first.** Identity on a board is a
  signed participant cookie; anyone with the board link can join,
  anyone without it cannot find the board. Google sign-in
  (`AUTH_MODE=optional`, live on dev since Oct 29; PIN-57) only
  *adds* the My boards / My pins library and cross-device
  restore — it never gates pinning or scene-making, and
  `AUTH_MODE=link-only` remains the default. Prod stays
  link-only until promotion.
- **Prod promotion pending.** Dev (https://dev.pinneds.com) is the
  live, model-backed demo. Firebase projects
  `moriacrew-pinned-dev` / `moriacrew-pinned-prod` exist (Firestore
  `eur3`, App Hosting `pinned-web` in `europe-west4`), but as of
  Oct 29 prod has not been promoted — don't treat `pinneds.com` as
  the demo URL yet.
- **Cuts can miss.** SAM returns no match for some named things;
  those simply don't become pins. Tap-to-add is the workaround.

## Hackathon note

Feature freeze is Tue Nov 3, 2026 (end of day); submission is due
Wed Nov 4, 2026, 9:00 PM ET. Until then, slices land as small
`PIN-*` PRs to `dev`; `main`/prod promotion rides the freeze.

Pinneds started this week as an AI-hosted photo game and pivoted to
Studio on Oct 28; the game design is kept for history in
`docs/archive/` only — nothing in this README describes the game.

## Docs

- `docs/11-studio.md` — Pinneds Studio spec: product, Policy, ports,
  jobs, data model, UX, slices, test plan, open questions
- `docs/adr/003-studio-architecture.md` — Policy as data, capability
  ports + decorators, jobs, Element/Pin split, stateless remix
- `docs/03-ai-sdlc.md` — issue → coding agent → PR → review workflow (solo + Muse)
- `docs/06-photo-intake.md` — photo intake and ephemeral storage
- `docs/07-sam-lab.md` — SAM 3.1 lab notes and measurements
- `docs/08-ux-principles.md` — minimal, icon-first UX rules
- `docs/09-design-system.md` — board themes (see docs/11 A5)
- `docs/10-custom-domains.md` — pinneds.com domain setup
- `docs/12-submission.md` — hackathon submission packet + video plan
- `docs/13-auth.md` — optional Google sign-in (`AUTH_MODE`), claim flow, user library
- `docs/archive/` — game-era requirements and research; history only
- `SECURITY.md` — public-repo guardrails: never-commit list + leak runbook
- `AGENTS.md` — instructions for coding agents working this repo

## License

Copyright (C) 2026 Moria Crew. AGPL-3.0 — see `LICENSE`. In short: you may use, study and modify this
code, but if you offer a modified version to others over a network you
must release your source under the same licence. Hackathon note: the
organisers separately receive a broad licence to submitted materials
under the event rules; the AGPL governs reuse by everyone else.
