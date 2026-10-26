# AGENTS.md — working in MoriaCrew/Pinned

You are a coding agent executing **one Linear issue at a time** for a
solo developer during a 10-day hackathon. Speed matters; scope discipline
matters more. Full workflow: `docs/03-ai-sdlc.md`. Requirements:
`docs/01-requirements.md`. Architecture: `docs/02-architecture.md`.

## Ground rules

1. **Issue first.** Work only the assigned `PIN-*` issue. Branch
   `PIN-{n}/short-slug` from `main`. File anything out-of-scope as a new
   Linear issue instead of building it.
2. **Small PRs.** One issue per PR, squash-merged to `main`. Fill the PR
   template completely (short `PIN-n` ID only — never a full Linear URL
   in this public repo; FR/NFR IDs, test evidence, AI/cost
   impact). CI green before requesting review. **Never merge before
   Cursor Bugbot finishes** (pending ≠ pass): triage each finding
   in-thread — fix, follow-up issue, or written dismissal. Medium+
   security findings block merge.
3. **AI behind the gateway.** All model calls go through `ModelGateway`
   (Meta Model API primary, partner fallback, mock for CI). Never call a
   provider SDK from UI/domain code. Never make paid calls in CI
   (`AI_MOCK=1` + fixtures).
4. **Prompts are code.** Templates live in `prompts/`, versioned; store
   the version with every generated output. Roast-policy / persona system
   prompts are safety-critical — changes need an eval-set pass noted in
   the PR (target: 0 policy violations).
5. **Privacy invariants (never break):** original photos are never
   persisted (cut-outs/posters only); EXIF stripped; secrets only from
   env; no keys, `.env`, or real player photos in git history.
6. **Public-repo guardrails (`SECURITY.md`):** run `pre-commit install`
   once per clone; never use `--no-verify` or force-push past a scanner;
   never print env values, full AI payloads or signed URLs into code,
   logs, PRs or Linear. If a scanner fires, treat the value as leaked:
   stop, tell the operator to rotate, then fix.
7. **Tests travel with code.** Domain logic (state machine, rubric,
   diary) gets unit tests; gateway changes get contract tests; UI changes
   get a phone-viewport click-through note + screenshot in the PR.
8. **Blocked? Stop and report** on the Linear issue with evidence and
   options. Do not silently narrow acceptance criteria, stub out a
   criterion, or disable a failing check to go green.

## Stack and commands (PIN-2 scaffold)

- **App:** Next.js App Router + TypeScript at repo root, React server
  components by default. Keep client components small and explicit.
- **Boundaries:** `src/domain` is pure and tested; `src/gateway` is the
  only AI-provider boundary; `src/config.ts` is the only place that reads
  `process.env`; UI strings go through `src/i18n` (EN complete, FR stub).
- **Firebase:** Firestore/Storage are server-only through Admin SDK in
  later issues. Client Firestore/Storage rules stay deny-all. Projects
  are `moriacrew-pinned-dev` (default) and `moriacrew-pinned-prod` in
  `.firebaserc`; project IDs are public, credentials are never committed.
- **Modes:** default `AUTH_MODE=link-only` and `AI_MOCK=1`. Players never
  authenticate. Do not add Firebase Auth, Stripe, or live model calls
  unless the assigned issue explicitly says so and its gate has passed.
- **Commands:** `npm run dev`, `npm run typecheck`, `npm test`,
  `npm run build`, `npm start`. Health check: `GET /api/health`.
- **Frontend:** mobile-first, 44px minimum targets, visible focus,
  semantic controls, reduced-motion support, no hard-coded UI strings.
- **Prompts:** start from `prompts/README.md`; bump the prompt version on
  any behavioral change and record eval evidence in the PR.

## Conventions

- Commits: `feat(game|ai|vision|poster|infra): …`, `fix(…): …`,
  `docs: …`, `chore(ci): …` — imperative, one logical step each.
- Cite FR/NFR IDs in PR descriptions (e.g. "Satisfies FR3.1, NFR4").
- Update `docs/` in the same PR when behaviour or decisions change.
- Deadline awareness: feature freeze **Nov 3 EOD**; submission
  **Nov 4, 9:00 PM ET**. Prefer the boring, shippable option.
