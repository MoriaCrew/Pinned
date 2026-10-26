# Pinned — Conceptual Design & Architecture

_Status: v0.1 (Day 1) · Companion to `01-requirements.md` (FR/NFR IDs).
Principle: the smallest architecture that survives 10 days of solo
development, real group-chat playtests, and judge traffic — with every
paid AI call behind one replaceable gateway._

## 1. System context

```
Group chat (WhatsApp/iMessage/Discord/…)
        │  paste link / nudges / poster
        ▼
Players' phone browsers ──► Pinned web app (pages + API)
                              │            │
                              │            ├─► Firestore via server repository port (game state)
                              │            ├─► Object store (cut-outs, posters ONLY)
                              │            └─► Job queue (segment, poster, close-at-deadline)
                              ▼
                         ModelGateway ──► Meta Model API (primary)
                              │             Muse Spark · SAM 3.1 · Muse Image
                              └──────────► Partner fallback (Spark Open via Baseten/Fireworks)
```

No native app, no websockets requirement: pages poll/refresh; deadline
closing runs on a scheduled job. Share/scoreboard pages are
server-rendered so chat link previews (Open Graph) work.

## 2. Domain model

- **GameChain** — identity of a rematch lineage; holds the rolling diary.
- **Game** — one link: slug (capability), admin token hash, challenge,
  deadline, state `DRAFT|OPEN|REVEAL|CLOSED`, chain FK, winner FK.
- **HostPersona** — structured JSON generated from the brief:
  `{name, voiceRules[], catchphrases[], judgingStyle, formats{}}` +
  prompt-template version. Immutable per game (rematch may regenerate).
- **Player** — per-game: display name, signed-cookie secret hash, roast
  level, poster opt-in. No global account; players never authenticate.
- **Creator identity (FR8, PIN-22)** — `AUTH_MODE=link-only` (default):
  admin token only. `optional`: Firebase Auth uid stored as nullable
  `creatorUid` on Game/GameChain; claim = present admin token once while
  signed in. Authorization accepts admin token OR matching uid in both
  modes, so the flag flips without migration. Entitlements + cost caps
  key off chain/creator, never off players.
- **i18n seam (FR9, PIN-23)** — UI strings in a message catalog (`en`
  complete, `fr` empty→fallback); persona JSON carries `language` for
  host voice, independent of UI locale. No hard-coded UI strings.
- **Submission** — per player per game (unique): cut-out URL, object
  label, rubric scores + reason, private judgement, public teaser,
  safety flags, status. Original photo: **never a column** — processed
  in the upload request / ephemeral job workspace, then deleted (NFR2).
- **Guess** — guesser → submission → guessed owner (REVEAL only, ≥4 rule).
- **Poster** — background prompt/result, composite URL, result-card URL.
- **DiaryEntry** — per closed game: `{winner, streaks{}, superlatives[],
  runningJokes[]}` capped (~1 KB); chain prompt includes last N entries.
- **AiCallLog** — model, operation, tokens/images, latency, cost est.,
  prompt version, outcome. Powers budget guard + eval (NFR4).

State transitions are server-enforced and idempotent; `OPEN→REVEAL`
fires from deadline job *or* admin force-close, whichever first.

## 3. AI pipelines (all via ModelGateway)

Gateway interface (provider-agnostic; Meta Model API first, partner
fallback by base-URL/key swap where OpenAI-compatible):

```
generatePersona(brief, diary?) -> PersonaJSON + challenge
judgePhoto(image, persona, challenge, roastCap) -> {objectLabel, scores, reason, judgement, teaser}
segmentObject(image, conceptPhrase) -> mask/cutout   (+ tap-point variant)
safetyScan(image) -> {screens?, documents?, faces?}   (warn-only in MVP)
posterBackground(persona, challenge, winnerLabel) -> image
writeDiary(gameSummary) -> DiaryEntryJSON
```

**PIN-3 model pins (Oct 26, 2026):** base `https://api.meta.ai/v1`,
Bearer auth; unauthenticated `GET /models` returns the OpenAI-style
`401 invalid_api_key` envelope (verified live). Spark
`muse-spark-1.3` via `/chat/completions` (text + vision), Muse Image
`muse-image-1.0` via `/images/generations`, SAM `sam-3.1` via
`/responses` (Responses-only; judge `objectLabel` becomes its
`input_text`). Standard IDs only — `*-contributor` variants never
touch player photos. Implementation: `src/gateway/meta-gateway.ts`
(plain fetch, no SDK) + `npm run smoke:meta` for live validation.
Still unverified until an authenticated smoke runs: SAM mask payload
keys (adapter searches defensively, `sam_shape_unknown` otherwise),
vision content-part acceptance, per-call cost/latency (PIN-15
measures), and account credit terms (PIN-27 operator check).

1. **Persona (Spark, text):** brief → constrained JSON. System prompt
   carries the roast policy; brief is treated as data, never instructions
   that can override policy (G6). One retry on schema failure, then a
   safe default persona ("The Unimpressed Host").
2. **Judging (Spark, vision):** two logical steps in one call where
   possible — name the salient object in plain nouns (feeds SAM), score
   Fit/Effort/Chaos with a one-line reason, then render judgement +
   teaser in persona voice *at or below* the player's roast cap.
   Output validated (score ranges, teaser contains no name/object leak).
3. **Segmentation (SAM 3.1):** concept phrase from step 2 → cut-out with
   transparent background. Player confirm loop: tap point re-segments;
   "use whole photo" bypasses. Failure never blocks submission (G4).
4. **Poster (Muse Image + compositor):** Image paints background/style
   only; server compositor lays cut-outs + winner text (G10). Opt-outs
   rendered as silhouettes. Fallback: generated gradient/pattern
   background if Image is unavailable or over budget.
5. **Diary (Spark, text):** closed-game facts → capped JSON (G9).

Every prompt lives in `prompts/` as a versioned template; the version is
stored with each output so playtest regressions are attributable.

## 4. Key flows

**Submit:** upload → validate/strip EXIF → safety scan (warn) → judge
(object label + scores) → segment → player confirms cut-out → persist
cut-out + judgement → teaser published. Original deleted at end of flow.
Heavy steps run as jobs with a friendly "the host is judging…" state.

**Close/Reveal:** deadline job or admin action → lock submissions →
build shuffled gallery → guessing (if ≥4) → reveal owners/scores →
winner = rubric total (tie-break: earlier submission; host narrates) →
poster job → diary job → scoreboard live.

**Rematch:** new Game in same chain; persona regenerated or reused;
diary injected into persona/challenge prompts; fresh slug + admin token.

## 5. Repo shape (PIN-2 scaffold, ADR-001)

```
Pinned/
├─ src/
│  ├─ app/            # Next.js routes, landing, API routes
│  ├─ domain/         # state machine, rubric, diary schemas (pure, tested)
│  ├─ gateway/        # ModelGateway interface; mock now, Meta in PIN-3
│  └─ i18n/           # EN catalog, FR stub, fallback helper
├─ prompts/           # versioned prompt templates and output contracts
├─ eval/              # golden-set policy and future runner (PIN-15)
├─ docs/              # requirements, architecture, SDLC, research
├─ .agents/skills/    # project-local Muse skill
└─ .github/           # CI + PR template
```

**ADR-001 (accepted Oct 26, PIN-2):** one Next.js TypeScript app at
the repository root, not a monorepo. This keeps Firebase App Hosting,
CI, and solo navigation simple while preserving pure domain logic,
the `ModelGateway` boundary, and a future server repository port.
Rejected alternatives: monorepo packages (extra navigation/deploy
friction), AWS assembly (more moving parts under deadline), and a
Postgres SaaS (better relational fit, but another vendor to wire now).
The boundaries matter more than the folder count.

## 6. Hosting, CI/CD (ADR-001)

**Criteria (in order):** (1) merge-to-production in minutes with preview
deploys per PR; (2) managed Firestore + object storage + cron/queue with
zero servers to patch; (3) secrets per environment; (4) free/cheap at
hackathon scale; (5) custom domain optional (judges use the host URL).

**Decision:** Firebase App Hosting serves the Next.js SSR app and API
routes; Firestore is accessed only through a server repository port;
Cloud Storage holds cut-outs/posters only (lifecycle-delete temp data);
Cloud Tasks plus a scheduler sweeper own deadlines and poster jobs.
Projects `moriacrew-pinned-dev` and `moriacrew-pinned-prod` use
Firestore in `eur3`; billing is enabled and `pinned-web` App Hosting
backends exist in `europe-west4`, GitHub-connected (PIN-28). Rollouts
are live on both backends; local and
CI verification do not depend on them. The boundaries above keep the
vendor decision reversible at the data/gateway ports.


**Branch → backend map (PIN-28):** the dev backend (environment
name `dev`) auto-builds the `dev` branch; the prod backend
(environment name `prod`) auto-builds `main`. Feature PRs merge
into `dev` first, get a hosted smoke on dev, then promote via a
`dev` → `main` PR. App Hosting merges `apphosting.dev.yaml` /
`apphosting.prod.yaml` over base `apphosting.yaml` per backend, so
both env files live on both branches. Secrets are added later as
Secret Manager references by name in the env files — values never
enter the repo; `AI_MOCK=1` stays on in both envs until the PIN-3
Meta secret exists.

**Environments:** Preview (per PR, `AI_MOCK=1` by default) → Production
(real keys, budget alerts). **CI gates on every PR:** secret scan,
typecheck, unit tests, build, and Bugbot review.
Gateway contract tests use fixtures. Nightly:
live smoke + eval-set run (manual trigger during hackathon is fine).

## 7. Cost guardrails (Meta credits; applied amount verified in PIN-27)

Per-game ceilings (submissions × judge+segment, 1 poster, 1 diary);
identical re-judges served from stored results; persona/poster cached
per game; daily spend check from `AiCallLog`; hard stop → mock/fallback
lines rather than a broken game. Partner credits (Baseten/Modal/
Fireworks) are overflow + open-weights path, not the primary budget.

## 8. Security & privacy notes

Unguessable slugs (≥128-bit), admin tokens hashed at rest, player
cookies signed + HttpOnly, upload type/size validation + re-encode,
rate limits on create/submit/judge, no originals at rest, no secrets in
repo (`.env.example` only), Standard (non-Contributor) API mode for any
real player photos. Public repo contains code + docs only — never keys,
never playtest photos.
