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
                              │            ├─► Postgres (game state)
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
  level, poster opt-in. No global account.
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

## 5. Repo shape (target; scaffolded incrementally via PIN issues)

```
Pinned/
├─ apps/web/          # web app: pages, API routes, compositor
├─ packages/
│  ├─ domain/         # state machine, rubric, diary schemas (pure, tested)
│  └─ model-gateway/  # ModelGateway impls: meta-api, partner, mock
├─ prompts/           # versioned prompt templates
├─ eval/              # 20-photo golden set + runner (seg/roast/cost)
├─ docs/              # requirements, architecture, SDLC, partners
└─ .github/           # CI + PR template
```

Monorepo-lite is preferred for solo speed; if scaffolding friction
appears, collapse to a single app with `src/domain` + `src/gateway`
folders — the boundaries matter, the folders don't.

## 6. Hosting, CI/CD (decision at scaffold — criteria fixed now)

**Criteria (in order):** (1) merge-to-production in minutes with preview
deploys per PR; (2) managed Postgres + object storage + cron/queue with
zero servers to patch; (3) secrets per environment; (4) free/cheap at
hackathon scale; (5) custom domain optional (judges use the host URL).

**Recommended default:** TypeScript web framework with server rendering
+ API routes on a managed serverless host; managed Postgres; S3-compatible
object storage (cut-outs/posters, lifecycle-delete anything else);
host cron/queue for deadline + poster jobs. Exact vendors are picked in
`PIN-2` and recorded here as an ADR; the domain/gateway boundaries above
make the pick reversible.

**Environments:** Preview (per PR, `AI_MOCK=1` by default) → Production
(real keys, budget alerts). **CI gates on every PR:** lint, typecheck,
unit tests (domain), gateway contract tests (fixtures), build. Nightly:
live smoke + eval-set run (manual trigger during hackathon is fine).

## 7. Cost guardrails (budget: $150 Meta API credits)

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
