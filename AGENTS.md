# AGENTS.md — working in MoriaCrew/Pinned

You are a coding agent executing **one Linear issue at a time** for a
solo developer during a hackathon. Speed matters; scope discipline
matters more. Studio spec: `docs/11-studio.md`. Architecture
decisions: `docs/adr/003-studio-architecture.md`. Full workflow:
`docs/03-ai-sdlc.md`. The game is dropped (Oct 28); its docs are in
`docs/archive/` (01, 02, 05) — do not apply them.

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
   `dev` → `main` PR after a hosted dev smoke.
3. **AI behind the gateway.** All model calls go through the gateway
   capability ports (`ElementNamer`, `Segmenter`, `SceneComposer`;
   `docs/11` §5.2) with the decorator chain: timeout → retry →
   reserve budget (fail closed) → call → log cost → fall back. Never
   call a provider SDK from UI/domain code. Never make paid calls in
   CI (`AI_MOCK=1` + fixtures). Provider refusals are the typed
   outcome `refused` with a friendly line — never a 500.
4. **No hard-coded limits.** Every count, size, cap, timeout and TTL
   comes from the one typed `Policy` object (`docs/11` §5.1:
   defaults → env → per-board overrides). Prompts, validators and UI
   read the same object. A new numeric literal for a limit in a PR
   is a review blocker.
5. **Prompts are code.** Templates live in `prompts/`, versioned
   (`elements.v1`, `scene.v1`); store the version with every
   generated output. Behavior changes need a golden-set pass noted
   in the PR.
6. **Privacy invariants (never break):** original photos are never
   persisted — only the stripped working copy (`tmp/`, Policy TTL;
   see `docs/11` A6) and derived cut-outs/scenes; EXIF stripped;
   secrets only from env; no keys, `.env`, or real personal photos
   in git history. People are allowed in pins: when Spark flags a
   face show the one-line consent note (`faces: note`), never block.
   Never claim "zero data retention" — Standard mode means not used
   for training, not not stored (`docs/11` §4).
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
   `YYYY-MM-DD HH:MM UTC — Muse Code — <event> — PR #n —
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
  that reads `process.env`; server modules carry `server-only`; UI
  strings go through `src/i18n` (EN complete, FR stub).
- **Firebase:** Firestore/Storage are server-only through Admin SDK.
  Client Firestore/Storage rules stay deny-all; assets are served
  through a route that checks the board link. Storage layout:
  `tmp/` (working copies, Policy TTL), `elements/` and `scenes/`
  (persistent). Projects are `moriacrew-pinned-dev` (default) and
  `moriacrew-pinned-prod` in `.firebaserc`; project IDs are public,
  credentials are never committed. Branch → backend: `dev` builds
  the dev backend, `main` builds prod (`docs/archive/02` §6).
- **Modes:** default `AUTH_MODE=link-only` and `AI_MOCK=1`. Board
  participants never authenticate; sign-in comes later behind
  `AUTH_MODE` (PIN-57). Do not add Firebase Auth or live model calls
  unless the assigned issue explicitly says so and its gate passed.
- **Commands:** `npm run dev`, `npm run typecheck`, `npm test`,
  `npm run build`, `npm start`. Health check: `GET /api/health`.
- **Frontend:** mobile-first, 44px minimum targets, visible focus,
  semantic controls, reduced-motion support, no hard-coded UI
  strings. Follow `docs/08` (icon + ≤6 words).
- **Prompts:** start from `prompts/README.md`; bump the prompt
  version on any behavioral change and record eval evidence in the
  PR. Test fixtures follow `eval/README.md` (synthetic only, source
  noted beside each).

## Conventions

- Commits: `feat(board|ai|vision|scene|infra): …`, `fix(…): …`,
  `docs: …`, `chore(ci): …` — imperative, one logical step each.
- Cite `docs/11` sections in PR descriptions (e.g. "Implements
  §5.2 decorator chain").
- Update `docs/` in the same PR when behaviour or decisions change.
  Only PIN-49 edits `docs/11` (A1); slice-0 findings land in
  `eval/studio-findings.md` (PIN-50).
- Deadline awareness: feature freeze **Nov 3 EOD**; submission
  **Nov 4, 9:00 PM ET**. Prefer the boring, shippable option.
