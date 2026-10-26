---
name: pinned-dev
description: Work safely and consistently on the Pinned Next.js, Firebase, and AI Gateway codebase.
---

# Pinned Development

Use this skill for implementation, debugging, testing, prompt, or Firebase
work in the Pinned repository.

## Start every task

1. Read the assigned `PIN-*` issue, then `AGENTS.md`.
2. Read only the relevant sections of `docs/01-requirements.md`,
   `docs/02-architecture.md`, and `docs/05-research-synthesis.md`.
3. Check `git status` and preserve changes you did not make.
4. Work on a `PIN-{n}/short-slug` branch from current `main`.

## Architecture rules

- Keep `src/domain` pure, deterministic, and unit-tested.
- Route every AI call through `src/gateway`; never import provider SDKs in
  UI or domain code.
- Read environment only through `src/config.ts`.
- Default to `AUTH_MODE=link-only` and `AI_MOCK=1`. Players never
  authenticate. Do not add Firebase Auth, Stripe, or live AI calls unless
  the assigned issue explicitly requires them and its gate has passed.
- Firestore and Storage are server-only. Keep client rules deny-all.
- Never persist original player photos. Persist only derived cut-outs and
  posters approved by the issue.
- Put all UI copy in `src/i18n/messages/en.json`; keep French as an empty
  fallback stub unless the issue explicitly requests translation.
- Prompt behavior changes update a versioned file under `prompts/` and
  require matching fixture or eval evidence.

## Verify

Run the narrowest relevant test first, then:

```bash
npm run typecheck
npm test
npm run build
```

For UI work, run `npm run dev`, open the affected route and
`http://localhost:3000/api/health`, and record a phone-viewport check in
the PR. Never use paid model calls in CI or ordinary tests; use the mock
gateway and fixtures. A live smoke belongs only to an issue that asks for
it, with secrets supplied outside git and spend recorded.

## Ship

Fill the PR template with the short `PIN-n` ID, requirement IDs, exact
test commands and outcomes, AI/cost impact, screenshots for UI work, and
rollback. Do not merge until CI, secret scan, and Cursor Bugbot finish;
triage every Bugbot finding in the PR. Never commit `.env*` values, keys,
service-account JSON, or real player photos.
