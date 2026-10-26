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
   template completely (Linear link, FR/NFR IDs, test evidence, AI/cost
   impact). CI green before requesting review.
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
6. **Tests travel with code.** Domain logic (state machine, rubric,
   diary) gets unit tests; gateway changes get contract tests; UI changes
   get a phone-viewport click-through note + screenshot in the PR.
7. **Blocked? Stop and report** on the Linear issue with evidence and
   options. Do not silently narrow acceptance criteria, stub out a
   criterion, or disable a failing check to go green.

## Conventions

- Commits: `feat(game|ai|vision|poster|infra): …`, `fix(…): …`,
  `docs: …`, `chore(ci): …` — imperative, one logical step each.
- Cite FR/NFR IDs in PR descriptions (e.g. "Satisfies FR3.1, NFR4").
- Update `docs/` in the same PR when behaviour or decisions change.
- Deadline awareness: feature freeze **Nov 3 EOD**; submission
  **Nov 4, 9:00 PM ET**. Prefer the boring, shippable option.
