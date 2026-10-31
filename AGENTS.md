# AGENTS.md — working in MoriaCrew/Pinned

You are a coding agent executing **one Linear issue at a time** for a
solo developer during a hackathon. Speed matters; scope discipline
matters more. Studio spec: `docs/11-studio.md`. Architecture
decisions: `docs/adr/003-studio-architecture.md`. Full workflow:
`docs/03-ai-sdlc.md`. Doc index: `docs/README.md`. The game is
dropped (Oct 28); its docs are in `docs/archive/` — do not apply them.

## Ground rules

1. **Issue first.** Work only the assigned `PIN-*` issue. Branch
   `PIN-{n}/short-slug` from `dev`. File anything out-of-scope as a
   new Linear issue instead of building it.
2. **Small PRs.** One issue per PR, to `dev`, titled `PIN-{n}: …`,
   squash-merged. Fill the PR template completely (short `PIN-n` ID
   only — never a full Linear URL in this public repo; test evidence,
   AI/cost impact). **Squash-merge to `dev` only when CI, gitleaks
   and Cursor Bugbot have ALL finished green** (pending ≠ pass):
   triage each Bugbot finding in-thread — fix, follow-up issue, or
   written dismissal. Medium+ security findings block merge.
   **Never merge to `main`** without Robin; promotion is a separate
   promotion PR into `main` (squash only, per the `Protect main`
   ruleset) after a hosted dev smoke (`docs/DEPLOY.md` §4).
3. **AI behind the gateway.** All model calls go through the six
   capability ports in `src/gateway/index.ts` (`ElementNamer`,
   `Segmenter`, `SceneComposer`, `ChipSuggester`, `TapNamer`,
   `SpeechTranscriber`; `docs/11` §5.2) with the decorator chain:
   timeout → retry → reserve budget (fail closed) → call → log cost →
   fall back. Never call a provider SDK from UI/domain code. Never
   make paid calls in CI (`AI_MOCK=1` + fixtures). Provider refusals
   are the typed outcome `refused` with a friendly line — never a 500.
4. **No hard-coded limits.** Every count, size, cap, timeout and TTL
   comes from the one typed `Policy` object (`docs/11` §5.1:
   defaults → env → per-board overrides). Prompts, validators and UI
   read the same object. A new numeric literal for a limit in a PR
   is a review blocker.
5. **Prompts are code.** Templates live in `prompts/` (start from
   `prompts/README.md`), versioned (`elements.v1`, `scene.v1`,
   `tap-name.v1`, `chips.v1`); store the version with every
   generated output. Behavior changes bump the version and need
   fixture or spike evidence (`eval/README.md`) noted in the PR.
6. **Privacy invariants (never break):** original photos are never
   persisted — only the stripped working copy (`tmp/`, deleted at
   "Pin selected" or past `workingCopyTtlHours`; `docs/11` A6) and
   derived cut-outs/scenes; dictation audio is never stored; EXIF
   stripped; secrets only from env; no keys, `.env`, or real
   personal photos in git history. People are allowed in pins: when
   Spark flags a face show the one-line consent note (`faces: note`),
   never block. Never claim "zero data retention" — Standard mode
   means not used for training, not not stored (`docs/11` §4).
7. **Public-repo guardrails (`SECURITY.md`):** run `pre-commit
   install` once per clone; never use `--no-verify` or force-push
   past a scanner; never print env values, full AI payloads or
   signed URLs into code, logs, PRs or Linear. If a scanner fires,
   treat the value as leaked: stop, tell the operator to rotate,
   then fix.
8. **Tests travel with code.** Domain and Policy logic gets unit
   tests; gateway changes get contract tests; UI changes get a
   phone-viewport click-through note + screenshot in the PR.
9. **Autonomy / stop rules.** Don't wait for Robin: run tests
   yourself, decide from the numbers and `docs/11` §2, record why in
   the PR. Split any issue over ~1 day or ~400 changed lines into
   child issues (Outcome, Scope, Checks, Stop conditions) first.
   **Stop and report** on the Linear issue (and at the top of the
   morning review), then continue with other unblocked work, only
   if: Muse Image cannot compose reference images at all; spend
   would exceed 3× budget; a change would store original photos or
   leak a secret; an operator-only step is needed (secrets, console,
   DNS). Never silently narrow acceptance criteria or disable a
   failing check to go green. Close each issue with evidence:
   `YYYY-MM-DD HH:MM UTC — <executor> — <event> — PR #n —
   <command> → <result>`.

## Stack and commands

- **App:** Next.js App Router + TypeScript at repo root, React server
  components by default. Keep client components small and explicit.
  Uploads use route handlers, not server actions; downscale on the
  client before upload. Board page polls (TanStack Query
  `refetchInterval`, refetch on focus, optimistic pins).
- **Jobs:** `DecomposeJob`/`SceneJob` docs
  (`pending → running → ready / failed / refused`), idempotent,
  claim-before-call; request does the work, client polls. No queue
  in slices 1–2 (`docs/11` A4).
- **Boundaries:** `src/domain` is pure and tested; `src/gateway` is
  the only AI-provider boundary; `src/config.ts` is the only place
  that reads `process.env`; server modules carry `server-only`.
- **i18n (`docs/18`):** UI strings go through `src/i18n`: 7 locales
  (en, fr, es, pt-BR, de, it, id) with catalog parity checks
  (`npm run i18n:check`). New strings go only in `en.json`, inside
  their prefix group; never hand-edit other locales or `*.lock.json`
  (missing keys fall back to English). `npm run i18n:translate`
  (Muse Spark Open, dev-time) fills the rest.
- **Firebase:** Firestore/Storage are server-only through Admin SDK.
  Client Firestore/Storage rules stay deny-all; assets are served
  through a route that checks the board link. Storage layout:
  `tmp/` (working copies, Policy TTL), `elements/` and `scenes/`
  (persistent). Projects are `moriacrew-pinned-dev` (default) and
  `moriacrew-pinned-prod` in `.firebaserc`; project IDs are public,
  credentials are never committed. Branch → backend: `dev` builds
  the dev backend, `main` builds prod (`docs/DEPLOY.md`).
- **Modes:** defaults `AUTH_MODE=link-only`, `AI_MOCK=1`,
  `PLUS_MODE=off`. Google sign-in (`AUTH_MODE=optional`, PIN-57,
  `docs/13`) and billing (`PLUS_MODE=mock|stripe`, `docs/15`) ship
  behind flags; flag-off behaviour must stay byte-identical
  (flag-off tests). Never commit keys (Meta, Stripe, Baseten,
  Firebase). No live model or Stripe calls unless the assigned issue
  says so and its gate passed.
- **Commands:** `npm run dev`, `npm run typecheck`, `npm test`,
  `npm run build`, `npm start`. Health check: `GET /api/health`.
- **Frontend:** mobile-first, 44px minimum targets, visible focus,
  semantic controls, reduced-motion support, no hard-coded UI
  strings, no emoji. Follow `docs/14` (kit in `src/ui/`, short
  verb-first labels).
- **Fixtures:** `eval/README.md` (synthetic only, source noted
  beside each).

## Conventions

- Commits: `feat(board|ai|vision|scene|infra): …`, `fix(…): …`,
  `docs: …`, `chore(ci): …` — imperative, one logical step each.
- Cite `docs/11` sections in PR descriptions (e.g. "Implements
  §5.2 decorator chain").
- Update `docs/` in the same PR when behaviour or decisions change;
  edit `docs/11` surgically. Measured results land in
  `eval/studio-findings.md`.
- Deadline awareness: feature freeze **Nov 3 EOD**; submission
  **Nov 4, 9:00 PM ET**. Prefer the boring, shippable option.

## Where to look

`docs/13` sign-in · `docs/14` look and kit · `docs/15` Board Plus and
makes · `docs/16` AI pricing, budget, logs · `docs/17` landing
showcase sets · `docs/18` languages · `docs/19` Meta models ·
`docs/DEPLOY.md` environments and promotion.
